import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { runMigrations } from '../../src/migrations/migration-runner.js';
import { DatabaseService } from '../../src/shared/infrastructure/database.service.js';
import { SchemaMigrationEntity } from '../../src/shared/infrastructure/schema-migration.entity.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from '../../src/wagering/application/submit-wager-transaction.use-case.js';
import { reconcileWallet, withDisposablePostgres } from '../support/postgres.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? test : test.skip;

function bet(input: {
  walletId: string;
  playerId: string;
  idempotencyKey: string;
  externalTransactionId: string;
  amount: string;
}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    walletId: input.walletId,
    playerId: input.playerId,
    roundId: 'round-concurrency',
    gameId: 'game-concurrency',
    kind: 'BET' as const,
    money: { amount: input.amount, currency: 'BRL' },
  };
}

integration(
  'serializes hot wallets while independent database instances proceed in parallel',
  async () => {
    await withDisposablePostgres(async (databaseUrl) => {
      await runMigrations(databaseUrl, 'up');
      const orms = await Promise.all(
        Array.from({ length: 3 }, () =>
          MikroORM.init({ clientUrl: databaseUrl, entities: [SchemaMigrationEntity] }),
        ),
      );
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const databases = orms.map((orm) => new DatabaseService(orm.em));
        const wallets = new CreateWalletUseCase(databases[0]!);
        const submitters = databases.map((database) => new SubmitWagerTransactionUseCase(database));
        const playerId = randomUUID();
        const wallet = await wallets.execute({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });

        const duplicate = bet({
          walletId: wallet.id,
          playerId,
          idempotencyKey: 'provider-a:parallel-duplicate',
          externalTransactionId: 'parallel-duplicate',
          amount: '25.00',
        });
        const duplicates = await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            submitters[index % submitters.length]!.submit(duplicate),
          ),
        );
        expect(duplicates.filter((result) => result?.idempotentReplay === false)).toHaveLength(1);
        expect(duplicates.filter((result) => result?.idempotentReplay === true)).toHaveLength(49);
        expect(await reconcileWallet(client, wallet.id)).toEqual({
          storedBalance: '75.00',
          calculatedBalance: '75.00',
          checkedEntries: '2',
        });

        const hotPlayer = randomUUID();
        const hotWallet = await wallets.execute({
          playerId: hotPlayer,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });
        const hot = await Promise.all([
          submitters[0]!.submit(
            bet({
              walletId: hotWallet.id,
              playerId: hotPlayer,
              idempotencyKey: 'provider-a:hot-a',
              externalTransactionId: 'hot-a',
              amount: '80.00',
            }),
          ),
          submitters[1]!.submit(
            bet({
              walletId: hotWallet.id,
              playerId: hotPlayer,
              idempotencyKey: 'provider-a:hot-b',
              externalTransactionId: 'hot-b',
              amount: '80.00',
            }),
          ),
        ]);
        expect(hot.map((result) => result?.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
        expect(hot.filter((result) => result?.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(
          1,
        );
        expect(await reconcileWallet(client, hotWallet.id)).toEqual({
          storedBalance: '20.00',
          calculatedBalance: '20.00',
          checkedEntries: '2',
        });

        const otherPlayer = randomUUID();
        const otherWallet = await wallets.execute({
          playerId: otherPlayer,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });
        const independent = await Promise.all([
          submitters[0]!.submit(
            bet({
              walletId: hotWallet.id,
              playerId: hotPlayer,
              idempotencyKey: 'provider-a:independent-hot',
              externalTransactionId: 'independent-hot',
              amount: '10.00',
            }),
          ),
          submitters[2]!.submit(
            bet({
              walletId: otherWallet.id,
              playerId: otherPlayer,
              idempotencyKey: 'provider-a:independent-other',
              externalTransactionId: 'independent-other',
              amount: '10.00',
            }),
          ),
        ]);
        expect(independent.map((result) => result?.status)).toEqual(['PROCESSED', 'PROCESSED']);
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
      } finally {
        await client.end();
        await Promise.all(orms.map((orm) => orm.close(true)));
      }
    });
  },
);
