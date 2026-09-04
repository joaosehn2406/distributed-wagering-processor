import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { addMilliseconds, exponentialBackoffMilliseconds } from '../shared/application/backoff.js';
import { loadEnvironment } from '../config/environment.js';
import { DatabaseService } from '../shared/infrastructure/database.service.js';
import { SqsService } from '../messaging/sqs.service.js';
import { WagerRepository } from '../wagering/infrastructure/wager.repository.js';
import { businessMetrics } from '../shared/infrastructure/metrics.service.js';
import { writeJsonLog } from '../shared/infrastructure/structured-logger.js';

const asDelay = (milliseconds: bigint): number => Number(milliseconds);
const eventField = (payload: Record<string, unknown>, field: string): string | undefined => {
  const data = payload.data;
  if (typeof data !== 'object' || data === null || !(field in data)) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Claims durable messages in a short transaction, publishes outside that
 * transaction, then conditionally finalizes the same lease. A process crash
 * after send can duplicate an event but cannot lose a committed one.
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;
  private readonly env = loadEnvironment();

  constructor(
    private readonly database: DatabaseService,
    private readonly sqs: SqsService,
  ) {}

  onModuleInit(): void {
    if (this.env.role === 'outbox-publisher' || this.env.role === 'all') {
      this.running = true;
      this.loop = this.work();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  async publishDue(): Promise<void> {
    const startedAt = Date.now();
    const now = new Date();
    const leaseUntil = addMilliseconds(now, this.env.outboxLeaseSeconds * 1_000n);
    const messages = await this.database.transaction((em) =>
      WagerRepository.claimDueOutbox(
        em,
        this.env.appInstanceId,
        leaseUntil,
        this.env.outboxBatchSize,
      ),
    );
    for (const message of messages) {
      try {
        await this.sqs.event(message.payload, message.eventId, message.aggregateId);
        const published = await this.database.transaction((em) =>
          WagerRepository.markOutboxPublished(em, message.id, message.leaseToken),
        );
        writeJsonLog(published ? 'info' : 'warn', published ? 'outbox.published' : 'outbox.lease_lost', {
          correlationId: String(message.payload.correlationId ?? message.eventId),
          transactionId: eventField(message.payload, 'transactionId'),
          walletId: message.aggregateId,
          providerId: eventField(message.payload, 'providerId'),
          component: 'outbox',
          status: published ? 'PUBLISHED' : 'LEASE_LOST',
        });
      } catch {
        const retryAt = addMilliseconds(
          new Date(),
          exponentialBackoffMilliseconds(
            message.attempts,
            this.env.outboxBackoffBaseSeconds,
            this.env.outboxBackoffMaxSeconds,
          ),
        );
        await this.database.transaction((em) =>
          WagerRepository.scheduleOutboxRetry(
            em,
            message.id,
            message.leaseToken,
            retryAt,
            'SQS_PUBLISH_FAILED',
          ),
        );
        businessMetrics.recordRetry('outbox');
        writeJsonLog('warn', 'outbox.retry_scheduled', {
          correlationId: String(message.payload.correlationId ?? message.eventId),
          transactionId: eventField(message.payload, 'transactionId'),
          walletId: message.aggregateId,
          providerId: eventField(message.payload, 'providerId'),
          component: 'outbox',
          code: 'SQS_PUBLISH_FAILED',
          retryable: true,
        });
      }
    }
    const lag = await this.database.transaction((em) => WagerRepository.outboxLag(em));
    const oldestAgeSeconds = lag.oldestCreatedAt
      ? Math.max(0, (Date.now() - lag.oldestCreatedAt.getTime()) / 1_000)
      : 0;
    businessMetrics.setOutboxLag(lag.pending, oldestAgeSeconds);
    businessMetrics.observeProcessingLatency('outbox', (Date.now() - startedAt) / 1_000);
  }

  private async work(): Promise<void> {
    while (this.running) {
      try {
        await this.publishDue();
      } catch {
        // The next poll will reclaim an expired lease or due retry.
      }
      if (this.running) await Bun.sleep(asDelay(this.env.outboxPollMilliseconds));
    }
  }
}
