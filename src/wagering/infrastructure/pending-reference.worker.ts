import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadEnvironment } from '../../config/environment.js';
import { addMilliseconds } from '../../shared/application/backoff.js';
import { DatabaseService } from '../../shared/infrastructure/database.service.js';
import { WagerRepository } from './wager.repository.js';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case.js';
import { businessMetrics } from '../../shared/infrastructure/metrics.service.js';
import { writeJsonLog } from '../../shared/infrastructure/structured-logger.js';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;
  private readonly env = loadEnvironment();

  constructor(
    private readonly database: DatabaseService,
    private readonly submit: SubmitWagerTransactionUseCase,
  ) {}

  onModuleInit(): void {
    if (this.env.role === 'pending-worker' || this.env.role === 'all') {
      this.running = true;
      this.loop = this.work();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  async retryDue(): Promise<void> {
    const startedAt = Date.now();
    const leaseUntil = addMilliseconds(new Date(), this.env.pendingClaimSeconds * 1_000n);
    const ids = await this.database.transaction((em) =>
      WagerRepository.claimDuePending(em, leaseUntil, this.env.pendingBatchSize),
    );
    for (const id of ids) {
      businessMetrics.recordRetry('pending_reference');
      await this.submit.retryPending(id);
      writeJsonLog('info', 'pending_reference.retried', {
        correlationId: id,
        transactionId: id,
        component: 'pending_reference',
      });
    }
    businessMetrics.observeProcessingLatency('pending_reference', (Date.now() - startedAt) / 1_000);
  }

  private async work(): Promise<void> {
    while (this.running) {
      try {
        await this.retryDue();
      } catch {
        // The persisted claim expires and another worker can safely retry.
      }
      if (this.running) await Bun.sleep(Number(this.env.pendingPollMilliseconds));
    }
  }
}
