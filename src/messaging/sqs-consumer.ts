import { createHash } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { loadEnvironment } from '../config/environment.js';
import { DomainError } from '../shared/domain/domain-error.js';
import {
  InboxConflictError,
  SubmitWagerTransactionUseCase,
} from '../wagering/application/submit-wager-transaction.use-case.js';
import type { SubmitCommand } from '../wagering/application/contracts.js';
import { SqsService } from './sqs.service.js';

interface Envelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  correlationId: string;
  data: Omit<SubmitCommand, 'idempotencyKey'> & { idempotencyKey: string };
}
@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;
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
    await this.loop;
  }
  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.env.wagerQueueUrl,
            WaitTimeSeconds: 10,
            VisibilityTimeout: 60,
            MaxNumberOfMessages: 10,
          }),
        );
        for (const message of batch.Messages ?? [])
          await this.handle(message.Body ?? '', message.MessageId ?? '', message.ReceiptHandle);
      } catch {
        if (this.running) await Bun.sleep(1_000);
      }
    }
  }
  private async handle(body: string, transportId: string, receipt?: string): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = this.parse(body);
    } catch {
      await this.sqs.dlq(body, createHash('sha256').update(body).digest('hex'));
      await this.ack(receipt);
      return;
    }
    const hash = createHash('sha256').update(body, 'utf8').digest('hex');
    try {
      await this.submit.submit(envelope.data, {
        consumerName: 'wager-transaction-consumer-v1',
        messageId: envelope.messageId,
        payloadHash: hash,
        transportMessageId: transportId,
      });
      await this.ack(receipt);
    } catch (error) {
      if (error instanceof InboxConflictError) {
        await this.sqs.dlq(body, envelope.messageId);
        await this.ack(receipt);
        return;
      }
      if (error instanceof DomainError) {
        await this.ack(receipt);
        return;
      }
      throw error;
    }
  }
  private parse(raw: string): Envelope {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('invalid');
    const e = value as Partial<Envelope>;
    if (
      typeof e.messageId !== 'string' ||
      e.type !== 'WagerTransactionRequested' ||
      !e.data ||
      typeof e.data !== 'object' ||
      typeof (e.data as { idempotencyKey?: unknown }).idempotencyKey !== 'string'
    )
      throw new Error('invalid');
    return e as Envelope;
  }
  private async ack(receipt?: string): Promise<void> {
    if (receipt)
      await this.sqs.client.send(
        new DeleteMessageCommand({ QueueUrl: this.env.wagerQueueUrl, ReceiptHandle: receipt }),
      );
  }
}
