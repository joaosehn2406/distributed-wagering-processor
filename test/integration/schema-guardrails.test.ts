import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { runMigrations } from '../../src/migrations/migration-runner.js';
import { withDisposablePostgres } from '../support/postgres.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? test : test.skip;
integration('ledger rejects direct mutation after migration', async () => {
  await withDisposablePostgres(async (databaseUrl) => {
    await runMigrations(databaseUrl, 'up');
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      const result = await client.query(
        "SELECT tgname FROM pg_trigger WHERE tgrelid='wallet_ledger_entries'::regclass AND NOT tgisinternal",
      );
      expect(result.rows.map((r) => r.tgname)).toContain('ledger_append_only');
      expect(result.rows.map((r) => r.tgname)).toContain('ledger_no_truncate');
    } finally {
      await client.end();
    }
  });
});
