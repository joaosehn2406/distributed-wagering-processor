import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const defaultDatabaseUrl = 'postgresql://wager:wager@localhost:5432/wagering';

/**
 * Uses a disposable database instead of the developer's database. The caller
 * must opt in through RUN_INTEGRATION before this helper is ever invoked.
 */
export async function withDisposablePostgres<T>(
  work: (databaseUrl: string) => Promise<T>,
): Promise<T> {
  const baseUrl =
    process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? defaultDatabaseUrl;
  const databaseName = `wagering_it_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    return await work(databaseUrl.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}

export async function reconcileWallet(
  client: Client,
  walletId: string,
): Promise<{ storedBalance: string; calculatedBalance: string; checkedEntries: string }> {
  const result = await client.query(
    `SELECT
       wallets.balance::text AS stored_balance,
       COALESCE(SUM(CASE WHEN ledger.direction='CREDIT' THEN ledger.amount ELSE -ledger.amount END), '0.00'::numeric)::numeric(20,2)::text AS calculated_balance,
       count(ledger.id)::text AS checked_entries
     FROM wallets
     LEFT JOIN wallet_ledger_entries AS ledger ON ledger.wallet_id=wallets.id
     WHERE wallets.id=$1
     GROUP BY wallets.id, wallets.balance`,
    [walletId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('wallet was not found during reconciliation');
  return {
    storedBalance: String(row.stored_balance),
    calculatedBalance: String(row.calculated_balance),
    checkedEntries: String(row.checked_entries),
  };
}
