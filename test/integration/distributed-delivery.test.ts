import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ChangeMessageVisibilityCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { runMigrations } from '../../src/migrations/migration-runner.js';
import { SqsConsumer } from '../../src/messaging/sqs-consumer.js';
import { SqsService } from '../../src/messaging/sqs.service.js';
import { OutboxPublisherWorker } from '../../src/outbox/outbox-publisher.worker.js';
import { DatabaseService } from '../../src/shared/infrastructure/database.service.js';
import { SchemaMigrationEntity } from '../../src/shared/infrastructure/schema-migration.entity.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from '../../src/wagering/application/submit-wager-transaction.use-case.js';
import { PendingReferenceWorker } from '../../src/wagering/infrastructure/pending-reference.worker.js';
import { reconcileWallet, withDisposablePostgres } from '../support/postgres.js';
import { createTestQueues, deleteTestQueues, receiveOne } from '../support/sqs.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? test : test.skip;
const environmentKeys = ['WAGER_QUEUE_URL', 'WAGER_DLQ_QUEUE_URL', 'WALLET_EVENTS_QUEUE_URL'];

function wagerEnvelope(input: {
  messageId: string;
  walletId: string;
  playerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  kind: 'BET' | 'REFUND';
  amount: string;
  referenceExternalTransactionId?: string;
}) {
  return {
    messageId: input.messageId,
    type: 'WagerTransactionRequested',
    version: 1,
    occurredAt: '2026-09-04T00:00:00.000Z',
    correlationId: `correlation:${input.messageId}`,
    data: {
      providerId: 'provider-a',
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: 'round-a',
      gameId: 'game-a',
      kind: input.kind,
      money: { amount: input.amount, currency: 'BRL' },
      ...(input.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: input.referenceExternalTransactionId }),
    },
  };
}

async function sendCommand(
  queueUrl: string,
  body: Record<string, unknown>,
  deduplicationId: string,
  groupId: string,
  client: Awaited<ReturnType<typeof createTestQueues>>['client'],
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageDeduplicationId: deduplicationId,
      MessageGroupId: groupId,
    }),
  );
}

async function deliverNext(
  consumer: SqsConsumer,
  queues: Awaited<ReturnType<typeof createTestQueues>>,
) {
  const message = await receiveOne(queues.client, queues.wagers);
  if (!message?.Body || !message.MessageId || !message.ReceiptHandle)
    throw new Error('expected a message from the commands queue');
  await consumer.processMessage(message.Body, message.MessageId, message.ReceiptHandle);
}

async function eventuallyReceive(
  queues: Awaited<ReturnType<typeof createTestQueues>>,
): Promise<Awaited<ReturnType<typeof receiveOne>>> {
  let attempts = 0;
  while (attempts < 3) {
    attempts += 1;
    const message = await receiveOne(queues.client, queues.wagers);
    if (message) return message;
  }
  return undefined;
}

integration(
  'handles persistent redelivery, outbox leases, DLQ, pending references and worker restart',
  async () => {
    const queues = await createTestQueues();
    const original = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    process.env.WAGER_QUEUE_URL = queues.wagers;
    process.env.WAGER_DLQ_QUEUE_URL = queues.wagerDlq;
    process.env.WALLET_EVENTS_QUEUE_URL = queues.events;
    try {
      await withDisposablePostgres(async (databaseUrl) => {
        await runMigrations(databaseUrl, 'up');
        const orm = await MikroORM.init({
          clientUrl: databaseUrl,
          entities: [SchemaMigrationEntity],
        });
        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        try {
          const database = new DatabaseService(orm.em);
          const wallets = new CreateWalletUseCase(database);
          const submit = new SubmitWagerTransactionUseCase(database);
          const sqs = new SqsService();
          const consumer = new SqsConsumer(sqs, submit);
          const playerId = randomUUID();
          const wallet = await wallets.execute({
            playerId,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          });

          // The opening committed before this publisher instance existed: restart recovery.
          await Promise.all([
            new OutboxPublisherWorker(database, sqs).publishDue(),
            new OutboxPublisherWorker(database, sqs).publishDue(),
          ]);
          const openingOutbox = await client.query(
            'SELECT count(*)::text AS count, max(attempts)::text AS attempts FROM outbox_messages WHERE aggregate_id=$1 AND published_at IS NOT NULL',
            [wallet.id],
          );
          expect(openingOutbox.rows[0]).toEqual({ count: '2', attempts: '1' });
          const openingEvent = await receiveOne(queues.client, queues.events);
          expect(JSON.parse(openingEvent?.Body ?? '{}')).toMatchObject({
            eventType: expect.any(String),
            version: 1,
          });

          const bet = wagerEnvelope({
            messageId: 'logical-bet-1',
            walletId: wallet.id,
            playerId,
            externalTransactionId: 'bet-1',
            idempotencyKey: 'provider-a:bet-1',
            kind: 'BET',
            amount: '25.00',
          });
          await sendCommand(queues.wagers, bet, 'transport-bet-1', wallet.id, queues.client);
          const firstDelivery = await receiveOne(queues.client, queues.wagers);
          if (!firstDelivery?.Body || !firstDelivery.MessageId || !firstDelivery.ReceiptHandle)
            throw new Error('expected first SQS delivery');
          // Commit without an ack simulates a process dying immediately after SQL commit.
          await consumer.processMessage(firstDelivery.Body, firstDelivery.MessageId);
          await queues.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queues.wagers,
              ReceiptHandle: firstDelivery.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          const redelivery = await receiveOne(queues.client, queues.wagers);
          if (!redelivery?.Body || !redelivery.MessageId || !redelivery.ReceiptHandle)
            throw new Error('expected SQS redelivery');
          expect(redelivery.MessageId).toBe(firstDelivery.MessageId);
          await consumer.processMessage(
            redelivery.Body,
            redelivery.MessageId,
            redelivery.ReceiptHandle,
            2n,
          );
          const redeliveryRows = await client.query(
            `SELECT
             (SELECT balance::text FROM wallets WHERE id=$1) AS balance,
             (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1) AS ledger,
             (SELECT count(*)::text FROM inbox_messages WHERE consumer_name='wager-transaction-consumer-v1' AND message_id='logical-bet-1') AS inbox`,
            [wallet.id],
          );
          expect(redeliveryRows.rows[0]).toEqual({ balance: '75.00', ledger: '2', inbox: '1' });

          await sendCommand(queues.wagers, {}, 'transport-invalid', 'invalid', queues.client);
          await deliverNext(consumer, queues);
          const invalidDlq = await receiveOne(queues.client, queues.wagerDlq);
          expect(invalidDlq?.Body).toBe('{}');
          expect(invalidDlq?.MessageAttributes?.failureReason?.StringValue).toBe(
            'permanent_payload',
          );
          expect(invalidDlq?.MessageAttributes?.logicalMessageId?.StringValue).toHaveLength(64);

          await client.query(`
          CREATE FUNCTION force_transient_ledger_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'temporary ledger failure'; END;
          $$;
          CREATE TRIGGER force_transient_ledger_failure
          BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW
          EXECUTE FUNCTION force_transient_ledger_failure();
        `);
          const transient = wagerEnvelope({
            messageId: 'logical-transient-bet',
            walletId: wallet.id,
            playerId,
            externalTransactionId: 'transient-bet',
            idempotencyKey: 'provider-a:transient-bet',
            kind: 'BET',
            amount: '1.00',
          });
          await sendCommand(
            queues.wagers,
            transient,
            'transport-transient-bet',
            wallet.id,
            queues.client,
          );
          await deliverNext(consumer, queues);
          const transientRollback = await client.query(
            `SELECT
             (SELECT count(*)::text FROM wager_transactions WHERE idempotency_key='provider-a:transient-bet') AS wagers,
             (SELECT count(*)::text FROM inbox_messages WHERE consumer_name='wager-transaction-consumer-v1' AND message_id='logical-transient-bet') AS inbox`,
          );
          expect(transientRollback.rows[0]).toEqual({ wagers: '0', inbox: '0' });
          await client.query(
            'DROP TRIGGER force_transient_ledger_failure ON wallet_ledger_entries; DROP FUNCTION force_transient_ledger_failure();',
          );
          const transientRedelivery = await eventuallyReceive(queues);
          if (
            !transientRedelivery?.Body ||
            !transientRedelivery.MessageId ||
            !transientRedelivery.ReceiptHandle
          )
            throw new Error('expected transient SQS redelivery');
          await consumer.processMessage(
            transientRedelivery.Body,
            transientRedelivery.MessageId,
            transientRedelivery.ReceiptHandle,
            2n,
          );

          const refund = wagerEnvelope({
            messageId: 'logical-refund-before-bet',
            walletId: wallet.id,
            playerId,
            externalTransactionId: 'refund-before-bet',
            idempotencyKey: 'provider-a:refund-before-bet',
            kind: 'REFUND',
            amount: '25.00',
            referenceExternalTransactionId: 'bet-pending',
          });
          await sendCommand(
            queues.wagers,
            refund,
            'transport-refund-before-bet',
            wallet.id,
            queues.client,
          );
          await deliverNext(consumer, queues);
          await sendCommand(
            queues.wagers,
            wagerEnvelope({
              messageId: 'logical-bet-pending',
              walletId: wallet.id,
              playerId,
              externalTransactionId: 'bet-pending',
              idempotencyKey: 'provider-a:bet-pending',
              kind: 'BET',
              amount: '25.00',
            }),
            'transport-bet-pending',
            wallet.id,
            queues.client,
          );
          await deliverNext(consumer, queues);
          await client.query(
            "UPDATE wager_transactions SET next_reference_attempt_at=now() WHERE external_transaction_id='refund-before-bet'",
          );
          // A fresh worker instance resumes durable pending work after restart.
          await new PendingReferenceWorker(database, submit).retryDue();
          const pendingRows = await client.query(
            "SELECT status,reference_attempts::text FROM wager_transactions WHERE external_transaction_id='refund-before-bet'",
          );
          expect(pendingRows.rows[0]).toEqual({ status: 'PROCESSED', reference_attempts: '1' });

          const expired = await submit.submit({
            providerId: 'provider-a',
            externalTransactionId: 'refund-expired-reference',
            idempotencyKey: 'provider-a:refund-expired-reference',
            playerId,
            walletId: wallet.id,
            roundId: 'round-a',
            gameId: 'game-a',
            kind: 'REFUND',
            money: { amount: '25.00', currency: 'BRL' },
            referenceExternalTransactionId: 'never-arrives',
          });
          expect(expired?.status).toBe('PENDING_REFERENCE');
          await client.query(
            "UPDATE wager_transactions SET next_reference_attempt_at=now(),reference_expires_at=now()-interval '1 second' WHERE external_transaction_id='refund-expired-reference'",
          );
          await new PendingReferenceWorker(database, submit).retryDue();
          const expiredRows = await client.query(
            "SELECT status,failure_code FROM wager_transactions WHERE external_transaction_id='refund-expired-reference'",
          );
          expect(expiredRows.rows[0]).toEqual({
            status: 'REJECTED',
            failure_code: 'REFERENCE_NOT_FOUND',
          });

          const loss = await submit.submit({
            providerId: 'provider-a',
            externalTransactionId: 'loss-for-outbox-retry',
            idempotencyKey: 'provider-a:loss-for-outbox-retry',
            playerId,
            walletId: wallet.id,
            roundId: 'round-a',
            gameId: 'game-a',
            kind: 'LOSS',
            money: { amount: '1.00', currency: 'BRL' },
          });
          if (!loss) throw new Error('LOSS result is required');
          process.env.WALLET_EVENTS_QUEUE_URL = `${queues.events}-missing`;
          await new OutboxPublisherWorker(database, new SqsService()).publishDue();
          const failedOutbox = await client.query(
            "SELECT published_at,last_error_code,attempts::text FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1",
            [loss.transactionId],
          );
          expect(failedOutbox.rows[0]).toMatchObject({
            published_at: null,
            last_error_code: 'SQS_PUBLISH_FAILED',
            attempts: '1',
          });
          process.env.WALLET_EVENTS_QUEUE_URL = queues.events;
          await client.query(
            "UPDATE outbox_messages SET next_attempt_at=now() WHERE payload->'data'->>'transactionId'=$1",
            [loss.transactionId],
          );
          await new OutboxPublisherWorker(database, new SqsService()).publishDue();
          const retriedOutbox = await client.query(
            "SELECT published_at,attempts::text FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1",
            [loss.transactionId],
          );
          expect(retriedOutbox.rows[0]?.published_at).not.toBeNull();
          expect(retriedOutbox.rows[0]?.attempts).toBe('2');

          expect(await reconcileWallet(client, wallet.id)).toEqual({
            storedBalance: '74.00',
            calculatedBalance: '74.00',
            checkedEntries: '5',
          });
        } finally {
          await client.end();
          await orm.close(true);
        }
      });
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await deleteTestQueues(queues);
    }
  },
  // Three SQS long polls can legitimately consume more than Bun's 5s default
  // when this real-service scenario runs alongside the rest of test:critical.
  { timeout: 30_000 },
);
