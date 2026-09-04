import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const transactions = new Counter({
  name: 'wager_transactions_total',
  help: 'Financial transactions completed by terminal or pending status.',
  labelNames: ['status'] as const,
  registers: [registry],
});
const duplicates = new Counter({
  name: 'wager_duplicate_deliveries_total',
  help: 'Persistent idempotency or Inbox replays detected.',
  labelNames: ['source'] as const,
  registers: [registry],
});
const retries = new Counter({
  name: 'wager_retries_total',
  help: 'Retries scheduled by a durable processing component.',
  labelNames: ['component'] as const,
  registers: [registry],
});
const dlqMessages = new Counter({
  name: 'wager_dlq_messages_total',
  help: 'Messages copied to a dead-letter queue by the consumer.',
  labelNames: ['reason'] as const,
  registers: [registry],
});
const lockConflicts = new Counter({
  name: 'wager_lock_conflicts_total',
  help: 'Database uniqueness or lock races requiring a retry/re-read.',
  registers: [registry],
});
const outboxLag = new Gauge({
  name: 'wager_outbox_pending_messages',
  help: 'Current number of unpublished integration events.',
  registers: [registry],
});
const outboxOldestAge = new Gauge({
  name: 'wager_outbox_oldest_age_seconds',
  help: 'Age of the oldest unpublished integration event in seconds.',
  registers: [registry],
});
const processingLatency = new Histogram({
  name: 'wager_processing_latency_seconds',
  help: 'Processing latency by entry point; never includes financial payloads.',
  labelNames: ['component'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [registry],
});
const reconciliationDivergences = new Counter({
  name: 'wager_reconciliation_divergences_total',
  help: 'Wallet balances that differ from the signed immutable ledger reconstruction.',
  registers: [registry],
});

@Injectable()
export class MetricsService {
  readonly registry = registry;
  readonly contentType = registry.contentType;

  recordTransaction(status: string): void {
    transactions.inc({ status });
  }

  recordDuplicate(source: 'idempotency' | 'inbox'): void {
    duplicates.inc({ source });
  }

  recordRetry(component: 'sqs_consumer' | 'outbox' | 'pending_reference'): void {
    retries.inc({ component });
  }

  recordDlq(reason: 'permanent_payload' | 'retry_exhausted' | 'inbox_conflict'): void {
    dlqMessages.inc({ reason });
  }

  recordLockConflict(): void {
    lockConflicts.inc();
  }

  recordReconciliationDivergence(): void {
    reconciliationDivergences.inc();
  }

  setOutboxLag(pending: bigint, oldestAgeSeconds: number): void {
    outboxLag.set(Number(pending));
    outboxOldestAge.set(oldestAgeSeconds);
  }

  observeProcessingLatency(
    component: 'http' | 'sqs_consumer' | 'outbox' | 'pending_reference',
    seconds: number,
  ): void {
    processingLatency.observe({ component }, seconds);
  }

  async text(): Promise<string> {
    return registry.metrics();
  }
}

/** Shared registry for Nest providers and adapters instantiated directly by integration tests. */
export const businessMetrics = new MetricsService();
