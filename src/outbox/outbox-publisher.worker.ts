import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadEnvironment } from '../config/environment.js';
import { DatabaseService } from '../shared/infrastructure/database.service.js';
import { SqsService } from '../messaging/sqs.service.js';

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
  private async work(): Promise<void> {
    while (this.running) {
      try {
        await this.publishBatch();
      } catch {
        /* retry state is persisted below */
      }
      await Bun.sleep(500);
    }
  }
  private async publishBatch(): Promise<void> {
    await this.database.transaction(async (em) => {
      const messages = await em
        .getConnection()
        .execute<
          Record<string, unknown>[]
        >('SELECT * FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 25');
      for (const item of messages) {
        try {
          const eventId = String(item.event_id);
          await this.sqs.event(
            item.payload as Record<string, unknown>,
            eventId,
            String(item.aggregate_id),
          );
          await em
            .getConnection()
            .execute(
              'UPDATE outbox_messages SET published_at=now(),attempts=attempts+1,last_error_code=NULL WHERE id=?',
              [item.id],
            );
        } catch {
          await em
            .getConnection()
            .execute(
              "UPDATE outbox_messages SET attempts=attempts+1,last_error_code='SQS_PUBLISH_FAILED',next_attempt_at=now() + LEAST(interval '5 minutes', (interval '1 second' * power(2,attempts))) WHERE id=?",
              [item.id],
            );
        }
      }
    });
  }
}
