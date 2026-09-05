import { createHash } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { loadEnvironment } from '../config/environment.js';
import { exponentialBackoffMilliseconds } from '../shared/application/backoff.js';
import { DomainError } from '../shared/domain/domain-error.js';
import { Money } from '../shared/domain/money.js';
import { businessMetrics } from '../shared/infrastructure/metrics.service.js';
import { writeJsonLog } from '../shared/infrastructure/structured-logger.js';
import {
  InboxConflictError,
  InboxInProgressError,
  SubmitWagerTransactionUseCase,
} from '../wagering/application/submit-wager-transaction.use-case.js';
import type { SubmitCommand } from '../wagering/application/contracts.js';
import { SqsService } from './sqs.service.js';

interface Envelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  version: 1;
  occurredAt: string;
  correlationId: string;
  data: Omit<SubmitCommand, 'correlationId'>;
}

class PermanentEnvelopeError extends Error {}

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new PermanentEnvelopeError(`${field} is required`);
  return value;
};

const boundedText = (value: unknown, field: string, maximum: bigint): string => {
  const text = requiredText(value, field);
  if (BigInt(text.length) > maximum) throw new PermanentEnvelopeError(`${field} is too long`);
  return text;
};

const validUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/**
 * SQS is acknowledged only after the SQL transaction has committed. Invalid
 * envelopes and Inbox collisions are copied to the DLQ before the source is
 * acknowledged. Transient failures receive broker-visible exponential backoff
 * and are sent to the DLQ only after the configured receive limit.
 */
@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;
  private readonly inFlight = new Map<string, string>();
  private readonly env = loadEnvironment();

  constructor(
    private readonly sqs: SqsService,
    private readonly submit: SubmitWagerTransactionUseCase,
  ) {}

  onModuleInit(): void {
    if (this.env.role === 'sqs-consumer' || this.env.role === 'all') {
      this.running = true;
      this.loop = this.poll();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (!this.loop) return;
    const completed = await Promise.race([
      this.loop.then(() => true),
      Bun.sleep(Number(this.env.consumerShutdownSeconds * 1_000n)).then(() => false),
    ]);
    if (!completed) await this.releaseInFlight();
  }

  async processMessage(
    body: string,
    transportId: string,
    receipt?: string,
    receiveCount = 1n,
  ): Promise<void> {
    const startedAt = Date.now();
    if (receipt) this.inFlight.set(receipt, transportId);
    try {
      let envelope: Envelope;
      try {
        envelope = this.parse(body);
      } catch (error) {
        if (!(error instanceof PermanentEnvelopeError)) throw error;
        await this.toDlqThenAck(
          body,
          createHash('sha256').update(body).digest('hex'),
          receipt,
          'permanent_payload',
        );
        return;
      }
      const hash = createHash('sha256').update(body, 'utf8').digest('hex');
      try {
        await this.submit.submit(
          { ...envelope.data, correlationId: envelope.correlationId },
          {
            consumerName: 'wager-transaction-consumer-v1',
            messageId: envelope.messageId,
            payloadHash: hash,
            transportMessageId: transportId,
          },
        );
        if (this.env.crashAfterCommitBeforeAckMessageId === envelope.messageId) {
          writeJsonLog('error', 'sqs.consumer_crash_after_commit', {
            correlationId: envelope.correlationId,
            messageId: envelope.messageId,
            walletId: envelope.data.walletId,
            providerId: envelope.data.providerId,
            component: 'sqs_consumer',
            code: 'CRASH_AFTER_COMMIT_BEFORE_ACK',
          });
          process.exit(86);
        }
      } catch (error) {
        if (
          error instanceof InboxInProgressError ||
          (error instanceof DomainError && error.code === 'TRANSIENT_UNIQUE_RACE')
        ) {
          await this.retryOrDlq(body, envelope.messageId, receipt, receiveCount);
          return;
        }
        if (error instanceof InboxConflictError) {
          await this.toDlqThenAck(body, envelope.messageId, receipt, 'inbox_conflict');
          return;
        }
        if (error instanceof DomainError) {
          writeJsonLog('info', 'sqs.business_error_acknowledged', {
            correlationId: envelope.correlationId,
            messageId: envelope.messageId,
            walletId: envelope.data.walletId,
            providerId: envelope.data.providerId,
            component: 'sqs_consumer',
            code: error.code,
          });
          await this.ack(receipt);
          return;
        }
        await this.retryOrDlq(body, envelope.messageId, receipt, receiveCount);
        return;
      }
      // An acknowledgement failure happens after the financial commit. Let the
      // broker redeliver it; Inbox turns that delivery into an acknowledgement-only replay.
      await this.ack(receipt);
    } finally {
      if (receipt) this.inFlight.delete(receipt);
      businessMetrics.observeProcessingLatency('sqs_consumer', (Date.now() - startedAt) / 1_000);
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.env.wagerQueueUrl,
            WaitTimeSeconds: Number(this.env.sqsLongPollSeconds),
            VisibilityTimeout: Number(this.env.sqsVisibilityTimeoutSeconds),
            MaxNumberOfMessages: Number(this.env.sqsBatchSize),
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        for (const message of batch.Messages ?? []) {
          if (!this.running) break;
          await this.processMessage(
            message.Body ?? '',
            message.MessageId ?? '',
            message.ReceiptHandle,
            this.receiveCount(message.Attributes?.ApproximateReceiveCount),
          );
        }
      } catch {
        if (this.running) await Bun.sleep(1_000);
      }
    }
  }

  private parse(raw: string): Envelope {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new PermanentEnvelopeError('invalid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new PermanentEnvelopeError('invalid envelope');
    const envelope = value as Record<string, unknown>;
    const messageId = boundedText(envelope.messageId, 'messageId', 255n);
    if (envelope.type !== 'WagerTransactionRequested')
      throw new PermanentEnvelopeError('invalid type');
    if (envelope.version !== 1) throw new PermanentEnvelopeError('unsupported event version');
    const occurredAt = requiredText(envelope.occurredAt, 'occurredAt');
    if (Number.isNaN(Date.parse(occurredAt)))
      throw new PermanentEnvelopeError('invalid occurredAt');
    const correlationId =
      envelope.correlationId === undefined
        ? messageId
        : requiredText(envelope.correlationId, 'correlationId');
    if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data))
      throw new PermanentEnvelopeError('invalid data');
    const data = envelope.data as Record<string, unknown>;
    const playerId = requiredText(data.playerId, 'data.playerId');
    const walletId = requiredText(data.walletId, 'data.walletId');
    if (!validUuid(playerId) || !validUuid(walletId))
      throw new PermanentEnvelopeError('invalid UUID');
    const kind = requiredText(data.kind, 'data.kind');
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind))
      throw new PermanentEnvelopeError('invalid kind');
    if (!data.money || typeof data.money !== 'object' || Array.isArray(data.money))
      throw new PermanentEnvelopeError('invalid money');
    const money = data.money as Record<string, unknown>;
    const amount = requiredText(money.amount, 'data.money.amount');
    const currency = requiredText(money.currency, 'data.money.currency');
    try {
      if (!Money.fromContract({ amount, currency }).isPositive())
        throw new PermanentEnvelopeError('data.money.amount must be positive');
    } catch (error) {
      if (error instanceof PermanentEnvelopeError) throw error;
      throw new PermanentEnvelopeError('invalid money');
    }
    const reference =
      data.referenceExternalTransactionId === undefined ||
      data.referenceExternalTransactionId === null
        ? undefined
        : boundedText(
            data.referenceExternalTransactionId,
            'data.referenceExternalTransactionId',
            200n,
          );
    return {
      messageId,
      type: 'WagerTransactionRequested',
      version: 1,
      occurredAt,
      correlationId,
      data: {
        providerId: boundedText(data.providerId, 'data.providerId', 100n),
        externalTransactionId: boundedText(
          data.externalTransactionId,
          'data.externalTransactionId',
          200n,
        ),
        idempotencyKey: boundedText(data.idempotencyKey, 'data.idempotencyKey', 255n),
        playerId,
        walletId,
        roundId: boundedText(data.roundId, 'data.roundId', 200n),
        gameId: boundedText(data.gameId, 'data.gameId', 200n),
        kind: kind as SubmitCommand['kind'],
        money: {
          amount,
          currency,
        },
        ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
      },
    } as Envelope;
  }

  private async toDlqThenAck(
    body: string,
    messageId: string,
    receipt: string | undefined,
    reason: 'permanent_payload' | 'retry_exhausted' | 'inbox_conflict',
  ): Promise<void> {
    await this.sqs.dlq(body, messageId);
    businessMetrics.recordDlq(reason);
    writeJsonLog('warn', 'sqs.message_dead_lettered', {
      messageId,
      component: 'sqs_consumer',
      code: reason,
    });
    await this.ack(receipt);
  }

  private async ack(receipt?: string): Promise<void> {
    if (receipt)
      await this.sqs.client.send(
        new DeleteMessageCommand({ QueueUrl: this.env.wagerQueueUrl, ReceiptHandle: receipt }),
      );
  }

  private receiveCount(raw: string | undefined): bigint {
    return raw && /^\d+$/.test(raw) && raw !== '0' ? BigInt(raw) : 1n;
  }

  private async retryOrDlq(
    body: string,
    messageId: string,
    receipt: string | undefined,
    receiveCount: bigint,
  ): Promise<void> {
    if (receiveCount >= this.env.sqsMaxReceiveAttempts) {
      await this.toDlqThenAck(body, messageId, receipt, 'retry_exhausted');
      return;
    }
    if (!receipt) throw new Error('SQS receipt is required to schedule retry');
    const milliseconds = exponentialBackoffMilliseconds(
      receiveCount,
      this.env.sqsRetryBackoffBaseSeconds,
      this.env.sqsRetryBackoffMaxSeconds,
    );
    const visibilitySeconds = (milliseconds + 999n) / 1_000n;
    businessMetrics.recordRetry('sqs_consumer');
    writeJsonLog('warn', 'sqs.retry_scheduled', {
      messageId,
      component: 'sqs_consumer',
      code: 'TRANSIENT_FAILURE',
      retryable: true,
    });
    await this.sqs.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.env.wagerQueueUrl,
        ReceiptHandle: receipt,
        VisibilityTimeout: Number(visibilitySeconds),
      }),
    );
  }

  private async releaseInFlight(): Promise<void> {
    await Promise.all(
      [...this.inFlight.keys()].map((receipt) =>
        this.sqs.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.env.wagerQueueUrl,
            ReceiptHandle: receipt,
            VisibilityTimeout: 0,
          }),
        ),
      ),
    );
  }
}
