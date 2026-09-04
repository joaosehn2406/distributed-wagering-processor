import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { runMigrations } from '../../src/migrations/migration-runner.js';
import { reconcileWallet, withDisposablePostgres } from '../support/postgres.js';
import { createTestQueues, deleteTestQueues } from '../support/sqs.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? test : test.skip;

async function eventually(
  assertion: () => Promise<boolean>,
  description: string,
  timeoutMilliseconds = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function stop(process: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    process.kill();
  } catch {
    // The crash test intentionally exits one child before cleanup.
  }
  await Promise.race([process.exited, Bun.sleep(5_000)]);
}

integration(
  'recovers a real post-commit/pre-ack crash across API, consumer and two publisher processes',
  async () => {
    const queues = await createTestQueues();
    const processes: ReturnType<typeof Bun.spawn>[] = [];
    const port = 31_000 + (process.pid % 1_000);
    try {
      await withDisposablePostgres(async (databaseUrl) => {
        await runMigrations(databaseUrl, 'up');
        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        const commonEnvironment = {
          ...process.env,
          DATABASE_URL: databaseUrl,
          SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
          AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          WAGER_QUEUE_URL: queues.wagers,
          WAGER_DLQ_QUEUE_URL: queues.wagerDlq,
          WALLET_EVENTS_QUEUE_URL: queues.events,
          SQS_VISIBILITY_TIMEOUT_SECONDS: '1',
          SQS_LONG_POLL_SECONDS: '1',
          SQS_RETRY_BACKOFF_BASE_SECONDS: '1',
          SQS_RETRY_BACKOFF_MAX_SECONDS: '1',
          OUTBOX_POLL_MILLISECONDS: '100',
          PENDING_POLL_MILLISECONDS: '100',
        };
        const start = (environment: Record<string, string | undefined>) => {
          const child = Bun.spawn({
            cmd: [process.execPath, 'src/main.ts'],
            cwd: process.cwd(),
            env: environment,
            stdout: 'ignore',
            stderr: 'ignore',
          });
          processes.push(child);
          return child;
        };
        try {
          const api = start({
            ...commonEnvironment,
            APP_ROLE: 'api',
            APP_INSTANCE_ID: 'process-test-api',
            PORT: String(port),
          });
          await eventually(async () => {
            try {
              return (await fetch(`http://127.0.0.1:${port}/health/ready`)).status === 200;
            } catch {
              return false;
            }
          }, 'API readiness backed by PostgreSQL and SQS');
          expect(api.exitCode).toBeNull();

          const invalid = await fetch(`http://127.0.0.1:${port}/wallets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-correlation-id': 'http-invalid' },
            body: '{}',
          });
          expect(invalid.status).toBe(400);
          expect(invalid.headers.get('x-correlation-id')).toBe('http-invalid');
          expect(await invalid.json()).toEqual({
            code: 'INVALID_PAYLOAD',
            message: 'INVALID_PAYLOAD',
            correlationId: 'http-invalid',
            retryable: false,
          });

          const playerId = randomUUID();
          const walletResponse = await fetch(`http://127.0.0.1:${port}/wallets`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-correlation-id': 'http-wallet' },
            body: JSON.stringify({
              playerId,
              initialBalance: { amount: '100.00', currency: 'BRL' },
            }),
          });
          expect(walletResponse.status).toBe(201);
          const wallet = (await walletResponse.json()) as { id: string };

          const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
          expect(metrics.status).toBe(200);
          expect(await metrics.text()).toContain('wager_outbox_pending_messages');

          const logicalMessageId = `crash-after-commit-${randomUUID()}`;
          const envelope = {
            messageId: logicalMessageId,
            type: 'WagerTransactionRequested',
            version: 1,
            occurredAt: new Date().toISOString(),
            correlationId: 'crash-recovery-correlation',
            data: {
              providerId: 'provider-a',
              externalTransactionId: 'crash-recovery-bet',
              idempotencyKey: 'provider-a:crash-recovery-bet',
              playerId,
              walletId: wallet.id,
              roundId: 'round-crash-recovery',
              gameId: 'game-crash-recovery',
              kind: 'BET',
              money: { amount: '25.00', currency: 'BRL' },
            },
          };
          await queues.client.send(
            new SendMessageCommand({
              QueueUrl: queues.wagers,
              MessageBody: JSON.stringify(envelope),
              MessageGroupId: wallet.id,
              MessageDeduplicationId: `transport-${logicalMessageId}`,
            }),
          );

          const crashConsumer = start({
            ...commonEnvironment,
            APP_ROLE: 'sqs-consumer',
            APP_INSTANCE_ID: 'process-test-crashing-consumer',
            RUN_CRASH_TEST: 'true',
            CRASH_AFTER_COMMIT_BEFORE_ACK_MESSAGE_ID: logicalMessageId,
          });
          expect(
            await Promise.race([
              crashConsumer.exited,
              Bun.sleep(20_000).then(() => {
                throw new Error('crashing consumer did not terminate');
              }),
            ]),
          ).toBe(86);
          await eventually(async () => {
            const row = await client.query(
              "SELECT count(*)::text AS count FROM inbox_messages WHERE consumer_name='wager-transaction-consumer-v1' AND message_id=$1 AND processed_at IS NOT NULL",
              [logicalMessageId],
            );
            return row.rows[0]?.count === '1';
          }, 'financial commit before crash');

          const recoveryConsumerMetricsPort = port + 1;
          const publisherAMetricsPort = port + 2;
          const publisherBMetricsPort = port + 3;
          start({
            ...commonEnvironment,
            APP_ROLE: 'sqs-consumer',
            APP_INSTANCE_ID: 'process-test-recovery-consumer',
            METRICS_PORT: String(recoveryConsumerMetricsPort),
          });
          start({
            ...commonEnvironment,
            APP_ROLE: 'outbox-publisher',
            APP_INSTANCE_ID: 'process-test-publisher-a',
            METRICS_PORT: String(publisherAMetricsPort),
          });
          start({
            ...commonEnvironment,
            APP_ROLE: 'outbox-publisher',
            APP_INSTANCE_ID: 'process-test-publisher-b',
            METRICS_PORT: String(publisherBMetricsPort),
          });
          await eventually(async () => {
            const responses = await Promise.all(
              [recoveryConsumerMetricsPort, publisherAMetricsPort, publisherBMetricsPort].map(
                async (metricsPort) => {
                  try {
                    return (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).status === 200;
                  } catch {
                    return false;
                  }
                },
              ),
            );
            return responses.every(Boolean);
          }, 'three independently started worker metric listeners');

          await eventually(async () => {
            const rows = await client.query(
              `SELECT
                 (SELECT balance::text FROM wallets WHERE id=$1) AS balance,
                 (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1) AS ledger,
                 (SELECT count(*)::text FROM inbox_messages WHERE consumer_name='wager-transaction-consumer-v1' AND message_id=$2) AS inbox,
                 (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id=$1 AND published_at IS NOT NULL) AS published`,
              [wallet.id, logicalMessageId],
            );
            const row = rows.rows[0];
            return (
              row?.balance === '75.00' &&
              row.ledger === '2' &&
              row.inbox === '1' &&
              row.published === '4'
            );
          }, 'redelivery acknowledgement and concurrent outbox publication');
          const attempts = await client.query(
            'SELECT max(attempts)::text AS max_attempts FROM outbox_messages WHERE aggregate_id=$1',
            [wallet.id],
          );
          expect(attempts.rows[0]?.max_attempts).toBe('1');
          expect(await reconcileWallet(client, wallet.id)).toEqual({
            storedBalance: '75.00',
            calculatedBalance: '75.00',
            checkedEntries: '2',
          });
        } finally {
          await Promise.all(processes.map((child) => stop(child)));
          await client.end();
        }
      });
    } finally {
      await deleteTestQueues(queues);
    }
  },
  { timeout: 90_000 },
);
