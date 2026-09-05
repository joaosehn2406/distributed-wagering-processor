import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { runMigrations } from '../../src/migrations/migration-runner.js';
import { withDisposablePostgres } from '../support/postgres.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? test : test.skip;

integration('migration runner supports up, repeated up, down, and up again', async () => {
  await withDisposablePostgres(async (databaseUrl) => {
    await runMigrations(databaseUrl, 'up');
    await runMigrations(databaseUrl, 'up');

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const applied = await client.query('SELECT name FROM schema_migrations ORDER BY name');
      expect(applied.rows).toEqual([
        { name: '0001_initial' },
        { name: '0002_outbox_leases' },
        { name: '0003_financial_guardrails' },
      ]);
      expect((await client.query("SELECT to_regclass('wallets') AS object")).rows[0]?.object).toBe(
        'wallets',
      );

      await runMigrations(databaseUrl, 'down');
      expect(
        (
          await client.query(
            "SELECT conname FROM pg_constraint WHERE conname='outbox_envelope_matches_columns_ck'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await client.query(
            "SELECT conname FROM pg_constraint WHERE conname='wager_terminal_snapshot_ck'",
          )
        ).rows,
      ).toEqual([]);
      expect((await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows).toEqual(
        [{ name: '0001_initial' }, { name: '0002_outbox_leases' }],
      );

      await runMigrations(databaseUrl, 'down');
      expect((await client.query("SELECT to_regclass('wallets') AS object")).rows[0]?.object).toBe(
        'wallets',
      );
      expect(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='outbox_messages' AND column_name='lease_token'",
          )
        ).rows,
      ).toEqual([]);
      expect((await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows).toEqual(
        [{ name: '0001_initial' }],
      );

      await runMigrations(databaseUrl, 'down');
      expect(
        (await client.query("SELECT to_regclass('wallets') AS object")).rows[0]?.object,
      ).toBeNull();
      expect(
        (await client.query("SELECT to_regprocedure('reject_ledger_mutation()') AS object")).rows[0]
          ?.object,
      ).toBeNull();
      expect((await client.query('SELECT name FROM schema_migrations')).rows).toEqual([]);

      await runMigrations(databaseUrl, 'up');
      expect(
        (await client.query("SELECT to_regclass('wallet_ledger_entries') AS object")).rows[0]
          ?.object,
      ).toBe('wallet_ledger_entries');
      expect(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='outbox_messages' AND column_name='lease_token'",
          )
        ).rows,
      ).toEqual([{ column_name: 'lease_token' }]);
      expect(
        (
          await client.query(
            "SELECT conname FROM pg_constraint WHERE conname='wager_terminal_snapshot_ck'",
          )
        ).rows,
      ).toEqual([{ conname: 'wager_terminal_snapshot_ck' }]);
    } finally {
      await client.end();
    }
  });
});
