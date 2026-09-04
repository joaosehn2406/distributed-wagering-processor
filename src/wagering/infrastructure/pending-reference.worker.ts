import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadEnvironment } from '../../config/environment.js';
import { DatabaseService } from '../../shared/infrastructure/database.service.js';
import { WagerRepository } from './wager.repository.js';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case.js';

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
  private async work(): Promise<void> {
    while (this.running) {
      try {
        const ids = await this.database.transaction(async (em) =>
          (await WagerRepository.pendingDue(em, 25n)).map((t) => t.id),
        );
        for (const id of ids) await this.submit.retryPending(id);
      } catch {}
      await Bun.sleep(1_000);
    }
  }
}
