import { expect, test } from 'bun:test';
import { MetricsService } from '../../src/shared/infrastructure/metrics.service.js';
import { jsonLogLine } from '../../src/shared/infrastructure/structured-logger.js';

test('emits a JSON log line with correlation fields and no financial payload', () => {
  const log = JSON.parse(
    jsonLogLine('info', 'wager.submitted', {
      correlationId: 'correlation-1',
      messageId: 'message-1',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider-1',
      component: 'http',
      status: 'PROCESSED',
    }),
  ) as Record<string, unknown>;
  expect(log).toMatchObject({
    level: 'info',
    event: 'wager.submitted',
    correlationId: 'correlation-1',
    messageId: 'message-1',
    transactionId: 'transaction-1',
    walletId: 'wallet-1',
    providerId: 'provider-1',
  });
  expect(log.amount).toBeUndefined();
  expect(log.payload).toBeUndefined();
});

test('exposes each required business metric through the Prometheus registry', async () => {
  const metrics = new MetricsService();
  metrics.recordTransaction('PROCESSED');
  metrics.recordDuplicate('inbox');
  metrics.recordRetry('sqs_consumer');
  metrics.recordDlq('permanent_payload');
  metrics.recordLockConflict();
  metrics.recordReconciliationDivergence();
  metrics.setOutboxLag(2n, 1);
  metrics.observeProcessingLatency('http', 0.01);
  const text = await metrics.text();
  for (const name of [
    'wager_transactions_total',
    'wager_duplicate_deliveries_total',
    'wager_retries_total',
    'wager_dlq_messages_total',
    'wager_lock_conflicts_total',
    'wager_outbox_pending_messages',
    'wager_outbox_oldest_age_seconds',
    'wager_processing_latency_seconds',
    'wager_reconciliation_divergences_total',
  ])
    expect(text).toContain(name);
});
