import { expect, test } from 'bun:test';
import { Client } from 'pg';

/** Runs against the real Compose PostgreSQL; it intentionally has no database mock. */
const integration = process.env.RUN_INTEGRATION === 'true' ? test : test.skip;
integration('ledger rejects direct mutation after migration', async () => {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ?? 'postgresql://wager:wager@localhost:5432/wagering',
  });
  try {
    await client.connect();
    const result = await client.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid='wallet_ledger_entries'::regclass AND NOT tgisinternal",
    );
    expect(result.rows.map((r) => r.tgname)).toContain('ledger_append_only');
  } finally {
    await client.end().catch(() => undefined);
  }
});
