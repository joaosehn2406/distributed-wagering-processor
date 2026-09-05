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
  timeoutMilliseconds = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function stop(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    child.kill();
  } catch {
    // A failed child is already stopped and its exit code is asserted by its caller.
  }
  await Promise.race([child.exited, Bun.sleep(5_000)]);
}

function wagerBody(input: {
  walletId: string;
  playerId: string;
  externalTransactionId: string;
  kind?: 'BET' | 'LOSS';
  amount: string;
}) {
  return {
    providerId: 'provider-three-processes',
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: 'round-three-processes',
    gameId: 'game-three-processes',
    kind: input.kind ?? 'BET',
    money: { amount: input.amount, currency: 'BRL' },
  };
}

async function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

integration(
  'three independent Nest processes share PostgreSQL and SQS without duplicate financial effects',
  async () => {
    const queues = await createTestQueues();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const basePort = 34_000 + (process.pid % 1_000) * 3;
    try {
      await withDisposablePostgres(async (databaseUrl) => {
        await runMigrations(databaseUrl, 'up');
        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        const commonEnvironment = {
          ...process.env,
          DATABASE_URL: databaseUrl,
          SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:45666',
          AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          WAGER_QUEUE_URL: queues.wagers,
          WAGER_DLQ_QUEUE_URL: queues.wagerDlq,
          WALLET_EVENTS_QUEUE_URL: queues.events,
          SQS_LONG_POLL_SECONDS: '1',
          SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
          OUTBOX_POLL_MILLISECONDS: '100',
          PENDING_POLL_MILLISECONDS: '100',
        };
        const start = (port: number, instanceId: string) => {
          const child = Bun.spawn({
            cmd: [process.execPath, 'src/main.ts'],
            cwd: process.cwd(),
            env: {
              ...commonEnvironment,
              APP_ROLE: 'all',
              APP_INSTANCE_ID: instanceId,
              PORT: String(port),
            },
            stdout: 'ignore',
            stderr: 'ignore',
          });
          children.push(child);
          return child;
        };
        try {
          const ports = [basePort, basePort + 1, basePort + 2];
          const instances = ports.map((port, index) => start(port, `three-processes-${index + 1}`));
          await eventually(async () => {
            const ready = await Promise.all(
              ports.map(async (port) => {
                try {
                  return (await fetch(`http://127.0.0.1:${port}/health/ready`)).status === 200;
                } catch {
                  return false;
                }
              }),
            );
            return ready.every(Boolean);
          }, 'three API, consumer and publisher roles to become ready');
          expect(instances.map((instance) => instance.exitCode)).toEqual([null, null, null]);

          const playerId = randomUUID();
          const walletResponse = await postJson(ports[0]!, '/wallets', {
            playerId,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          });
          expect(walletResponse.status).toBe(201);
          const wallet = (await walletResponse.json()) as { id: string };

          const duplicateBody = wagerBody({
            walletId: wallet.id,
            playerId,
            externalTransactionId: 'parallel-duplicate',
            amount: '25.00',
          });
          const duplicateResponses = await Promise.all(
            Array.from({ length: 50 }, (_, index) =>
              postJson(ports[index % ports.length]!, '/wagering/transactions', duplicateBody, {
                'idempotency-key': 'provider-three-processes:parallel-duplicate',
              }),
            ),
          );
          expect(duplicateResponses.filter((response) => response.status === 201)).toHaveLength(1);
          expect(duplicateResponses.filter((response) => response.status === 200)).toHaveLength(49);
          const duplicateRows = await client.query(
            `SELECT
               (SELECT count(*)::text FROM wager_transactions WHERE provider_id='provider-three-processes' AND external_transaction_id='parallel-duplicate') AS wagers,
               (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT') AS debits`,
            [wallet.id],
          );
          expect(duplicateRows.rows[0]).toEqual({ wagers: '1', debits: '1' });
          expect(await reconcileWallet(client, wallet.id)).toEqual({
            storedBalance: '75.00',
            calculatedBalance: '75.00',
            checkedEntries: '2',
          });

          const hotPlayer = randomUUID();
          const hotWalletResponse = await postJson(ports[1]!, '/wallets', {
            playerId: hotPlayer,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          });
          expect(hotWalletResponse.status).toBe(201);
          const hotWallet = (await hotWalletResponse.json()) as { id: string };
          const hotResponses = await Promise.all([
            postJson(
              ports[0]!,
              '/wagering/transactions',
              wagerBody({
                walletId: hotWallet.id,
                playerId: hotPlayer,
                externalTransactionId: 'hot-a',
                amount: '80.00',
              }),
              { 'idempotency-key': 'provider-three-processes:hot-a' },
            ),
            postJson(
              ports[2]!,
              '/wagering/transactions',
              wagerBody({
                walletId: hotWallet.id,
                playerId: hotPlayer,
                externalTransactionId: 'hot-b',
                amount: '80.00',
              }),
              { 'idempotency-key': 'provider-three-processes:hot-b' },
            ),
          ]);
          expect(hotResponses.map((response) => response.status).sort()).toEqual([201, 422]);
          const hotRows = await client.query(
            `SELECT
               count(*) FILTER (WHERE status='PROCESSED')::text AS processed,
               count(*) FILTER (WHERE status='REJECTED' AND failure_code='INSUFFICIENT_FUNDS')::text AS rejected,
               (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT') AS debits
             FROM wager_transactions
             WHERE provider_id='provider-three-processes' AND external_transaction_id IN ('hot-a','hot-b')`,
            [hotWallet.id],
          );
          expect(hotRows.rows[0]).toEqual({ processed: '1', rejected: '1', debits: '1' });
          expect(await reconcileWallet(client, hotWallet.id)).toEqual({
            storedBalance: '20.00',
            calculatedBalance: '20.00',
            checkedEntries: '2',
          });

          const otherPlayer = randomUUID();
          const otherWalletResponse = await postJson(ports[2]!, '/wallets', {
            playerId: otherPlayer,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          });
          expect(otherWalletResponse.status).toBe(201);
          const otherWallet = (await otherWalletResponse.json()) as { id: string };
          const independentResponses = await Promise.all([
            postJson(
              ports[0]!,
              '/wagering/transactions',
              wagerBody({
                walletId: hotWallet.id,
                playerId: hotPlayer,
                externalTransactionId: 'independent-hot',
                amount: '10.00',
              }),
              { 'idempotency-key': 'provider-three-processes:independent-hot' },
            ),
            postJson(
              ports[1]!,
              '/wagering/transactions',
              wagerBody({
                walletId: otherWallet.id,
                playerId: otherPlayer,
                externalTransactionId: 'independent-other',
                amount: '10.00',
              }),
              { 'idempotency-key': 'provider-three-processes:independent-other' },
            ),
          ]);
          expect(independentResponses.map((response) => response.status)).toEqual([201, 201]);
          expect(await reconcileWallet(client, hotWallet.id)).toEqual({
            storedBalance: '10.00',
            calculatedBalance: '10.00',
            checkedEntries: '3',
          });
          expect(await reconcileWallet(client, otherWallet.id)).toEqual({
            storedBalance: '90.00',
            calculatedBalance: '90.00',
            checkedEntries: '2',
          });

          const sqsMessageId = `three-processes-sqs-${randomUUID()}`;
          await queues.client.send(
            new SendMessageCommand({
              QueueUrl: queues.wagers,
              MessageBody: JSON.stringify({
                messageId: sqsMessageId,
                type: 'WagerTransactionRequested',
                version: 1,
                occurredAt: new Date().toISOString(),
                correlationId: `correlation:${sqsMessageId}`,
                data: {
                  ...wagerBody({
                    walletId: otherWallet.id,
                    playerId: otherPlayer,
                    externalTransactionId: 'sqs-loss',
                    kind: 'LOSS',
                    amount: '1.00',
                  }),
                  idempotencyKey: 'provider-three-processes:sqs-loss',
                },
              }),
              MessageGroupId: otherWallet.id,
              MessageDeduplicationId: sqsMessageId,
            }),
          );
          await eventually(async () => {
            const result = await client.query(
              `SELECT
                 (SELECT count(*)::text FROM inbox_messages WHERE consumer_name='wager-transaction-consumer-v1' AND message_id=$1 AND processed_at IS NOT NULL) AS inbox,
                 (SELECT status FROM wager_transactions WHERE provider_id='provider-three-processes' AND external_transaction_id='sqs-loss') AS status`,
              [sqsMessageId],
            );
            return result.rows[0]?.inbox === '1' && result.rows[0]?.status === 'PROCESSED';
          }, 'one of the three SQS consumers to commit and acknowledge the command');
          expect(await reconcileWallet(client, otherWallet.id)).toEqual({
            storedBalance: '90.00',
            calculatedBalance: '90.00',
            checkedEntries: '2',
          });
        } finally {
          await Promise.all(children.map((child) => stop(child)));
          await client.end();
        }
      });
    } finally {
      await deleteTestQueues(queues);
    }
  },
  { timeout: 120_000 },
);
