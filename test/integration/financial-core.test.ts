import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { runMigrations } from '../../src/migrations/migration-runner.js';
import { DatabaseService } from '../../src/shared/infrastructure/database.service.js';
import { SchemaMigrationEntity } from '../../src/shared/infrastructure/schema-migration.entity.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../src/wallet/application/reconcile-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from '../../src/wagering/application/submit-wager-transaction.use-case.js';
import { reconcileWallet, withDisposablePostgres } from '../support/postgres.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? test : test.skip;
const playerId = () => randomUUID();

function command(input: {
  walletId: string;
  playerId: string;
  idempotencyKey: string;
  externalTransactionId: string;
  kind: 'BET' | 'LOSS';
  amount: string;
}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    walletId: input.walletId,
    playerId: input.playerId,
    roundId: 'round-a',
    gameId: 'game-a',
    kind: input.kind,
    money: { amount: input.amount, currency: 'BRL' },
  };
}

integration('persists the financial core atomically and enforces schema guardrails', async () => {
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
      const reconciliation = new ReconcileWalletUseCase(database);
      const wagers = new SubmitWagerTransactionUseCase(database);

      const zeroPlayer = playerId();
      const zero = await wallets.execute({
        playerId: zeroPlayer,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });
      expect(zero).toEqual({
        id: zero.id,
        playerId: zeroPlayer,
        balance: { amount: '0.00', currency: 'BRL' },
        version: '1',
      });
      const zeroRows = await client.query(
        `SELECT
           (SELECT count(*)::text FROM wager_transactions WHERE wallet_id=$1) AS wagers,
           (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1) AS ledger,
           (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id=$1) AS outbox`,
        [zero.id],
      );
      expect(zeroRows.rows[0]).toEqual({ wagers: '0', ledger: '0', outbox: '0' });

      const openingPlayer = playerId();
      const opening = await wallets.execute({
        playerId: openingPlayer,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(opening.version).toBe('1');
      const openingRows = await client.query(
        `SELECT
           (SELECT count(*)::text FROM wager_transactions WHERE wallet_id=$1 AND kind='OPENING' AND status='PROCESSED') AS openings,
           (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='CREDIT' AND amount=100.00) AS credits,
           (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id=$1) AS outbox`,
        [opening.id],
      );
      expect(openingRows.rows[0]).toEqual({ openings: '1', credits: '1', outbox: '2' });

      const bet = await wagers.submit(
        command({
          walletId: opening.id,
          playerId: openingPlayer,
          idempotencyKey: 'provider-a:bet-1',
          externalTransactionId: 'bet-1',
          kind: 'BET',
          amount: '25.00',
        }),
      );
      expect(bet).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        walletVersion: '2',
        idempotentReplay: false,
      });

      const loss = await wagers.submit(
        command({
          walletId: opening.id,
          playerId: openingPlayer,
          idempotencyKey: 'provider-a:loss-1',
          externalTransactionId: 'loss-1',
          kind: 'LOSS',
          amount: '25.00',
        }),
      );
      expect(loss).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        walletVersion: '2',
      });

      const rejected = await wagers.submit(
        command({
          walletId: opening.id,
          playerId: openingPlayer,
          idempotencyKey: 'provider-a:bet-insufficient',
          externalTransactionId: 'bet-insufficient',
          kind: 'BET',
          amount: '100.00',
        }),
      );
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '75.00', currency: 'BRL' },
        walletVersion: '2',
      });
      const postBusinessRows = await client.query(
        `SELECT balance::text, version::text,
           (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1) AS ledger
         FROM wallets WHERE id=$1`,
        [opening.id],
      );
      expect(postBusinessRows.rows[0]).toEqual({ balance: '75.00', version: '2', ledger: '2' });

      const atomicPlayer = playerId();
      const atomicWallet = await wallets.execute({
        playerId: atomicPlayer,
        initialBalance: { amount: '30.00', currency: 'BRL' },
      });
      await client.query(`
        CREATE FUNCTION force_ledger_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced ledger failure'; END;
        $$;
        CREATE TRIGGER force_ledger_insert_failure
        BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW
        EXECUTE FUNCTION force_ledger_insert_failure();
      `);
      const failingKey = 'provider-a:atomic-failure';
      await expect(
        wagers.submit(
          command({
            walletId: atomicWallet.id,
            playerId: atomicPlayer,
            idempotencyKey: failingKey,
            externalTransactionId: 'atomic-failure',
            kind: 'BET',
            amount: '10.00',
          }),
          {
            consumerName: 'wager-transaction-consumer-v1',
            messageId: 'message-atomic-failure',
            payloadHash: 'a'.repeat(64),
            transportMessageId: 'transport-atomic-failure',
          },
        ),
      ).rejects.toThrow('forced ledger failure');
      await client.query(
        'DROP TRIGGER force_ledger_insert_failure ON wallet_ledger_entries; DROP FUNCTION force_ledger_insert_failure();',
      );
      const rollbackRows = await client.query(
        `SELECT
           (SELECT balance::text FROM wallets WHERE id=$1) AS balance,
           (SELECT version::text FROM wallets WHERE id=$1) AS version,
           (SELECT count(*)::text FROM wager_transactions WHERE idempotency_key=$2) AS wagers,
           (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=$1) AS ledger,
           (SELECT count(*)::text FROM inbox_messages WHERE consumer_name='wager-transaction-consumer-v1' AND message_id='message-atomic-failure') AS inbox,
           (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id=$1) AS outbox`,
        [atomicWallet.id, failingKey],
      );
      expect(rollbackRows.rows[0]).toEqual({
        balance: '30.00',
        version: '1',
        wagers: '0',
        ledger: '1',
        inbox: '0',
        outbox: '2',
      });

      await expect(
        client.query(
          'INSERT INTO wallets(id,player_id,currency,balance,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,now(),now())',
          [randomUUID(), openingPlayer, 'BRL', '0.00', '1'],
        ),
      ).rejects.toThrow('wallets_player_currency_uk');
      await expect(
        client.query('UPDATE wallets SET balance=-1.00 WHERE id=$1', [opening.id]),
      ).rejects.toThrow('wallets_balance_nonnegative_ck');
      await expect(
        client.query(
          `INSERT INTO wager_transactions(
             id,provider_id,external_transaction_id,idempotency_key,payload_hash,
             wallet_id,player_id,round_id,game_id,kind,amount,currency,status,
             reference_attempts,created_at,updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now()
           )`,
          [
            randomUUID(),
            'provider-a',
            'zero-amount',
            'provider-a:zero-amount',
            'b'.repeat(64),
            opening.id,
            openingPlayer,
            'round-a',
            'game-a',
            'BET',
            '0.00',
            'BRL',
            'PENDING',
            '0',
          ],
        ),
      ).rejects.toThrow('wager_amount_positive_ck');

      const lossForConstraints = await wagers.submit(
        command({
          walletId: opening.id,
          playerId: openingPlayer,
          idempotencyKey: 'provider-a:loss-constraint',
          externalTransactionId: 'loss-constraint',
          kind: 'LOSS',
          amount: '1.00',
        }),
      );
      if (!lossForConstraints) throw new Error('LOSS result is required for constraints');
      await expect(
        client.query(
          `INSERT INTO wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
           VALUES ($1,$2,$3,'CREDIT','1.00','USD','0.00','1.00',now())`,
          [randomUUID(), opening.id, lossForConstraints.transactionId],
        ),
      ).rejects.toThrow('ledger_wallet_currency_fk');
      await expect(
        client.query(
          `INSERT INTO wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
           VALUES ($1,$2,$3,'CREDIT','1.00','BRL','0.00','0.00',now())`,
          [randomUUID(), opening.id, lossForConstraints.transactionId],
        ),
      ).rejects.toThrow('ledger_arithmetic_ck');
      await expect(
        client.query('UPDATE wallet_ledger_entries SET amount=99.00 WHERE wallet_id=$1', [
          opening.id,
        ]),
      ).rejects.toThrow('wallet ledger is append-only');
      await expect(
        client.query('DELETE FROM wallet_ledger_entries WHERE wallet_id=$1', [opening.id]),
      ).rejects.toThrow('wallet ledger is append-only');
      await expect(client.query('TRUNCATE wallet_ledger_entries')).rejects.toThrow(
        'wallet ledger is append-only',
      );
      expect(await reconcileWallet(client, zero.id)).toEqual({
        storedBalance: '0.00',
        calculatedBalance: '0.00',
        checkedEntries: '0',
      });
      expect(await reconcileWallet(client, opening.id)).toEqual({
        storedBalance: '75.00',
        calculatedBalance: '75.00',
        checkedEntries: '2',
      });
      expect(await reconcileWallet(client, atomicWallet.id)).toEqual({
        storedBalance: '30.00',
        calculatedBalance: '30.00',
        checkedEntries: '1',
      });
      expect(await reconciliation.execute(opening.id, 'integration-financial-core')).toEqual({
        walletId: opening.id,
        consistent: true,
        storedBalance: { amount: '75.00', currency: 'BRL' },
        calculatedBalance: { amount: '75.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        checkedEntries: '2',
      });
    } finally {
      await client.end();
      await orm.close(true);
    }
  });
});
