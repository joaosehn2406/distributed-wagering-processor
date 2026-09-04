import { MikroORM } from '@mikro-orm/postgresql';
import { migration0001 } from './Migration0001Initial.js';
import { migration0002 } from './Migration0002OutboxLeases.js';
import { SchemaMigrationEntity } from '../shared/infrastructure/schema-migration.entity.js';

const migrations = [migration0001, migration0002] as const;

export type MigrationCommand = 'up' | 'down';

/**
 * Applies at most the missing migrations, or reverts exactly the last known
 * migration. The schema marker is always written or deleted in the same SQL
 * transaction as its migration body.
 */
export async function runMigrations(databaseUrl: string, command: MigrationCommand): Promise<void> {
  const orm = await MikroORM.init({
    clientUrl: databaseUrl,
    entities: [SchemaMigrationEntity],
  });
  try {
    const connection = orm.em.getConnection();
    await connection.execute(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const appliedRows = await connection.execute<{ name: string }[]>(
      'SELECT name FROM schema_migrations',
    );
    const applied = new Set(appliedRows.map((row) => row.name));

    if (command === 'up') {
      for (const migration of migrations) {
        if (applied.has(migration.name)) continue;
        await orm.em.transactional(async (em) => {
          await em.getConnection().execute(migration.up);
          await em
            .getConnection()
            .execute('INSERT INTO schema_migrations(name) VALUES (?)', [migration.name]);
        });
      }
      return;
    }

    const migration = [...migrations].reverse().find((item) => applied.has(item.name));
    if (!migration) return;
    await orm.em.transactional(async (em) => {
      await em.getConnection().execute(migration.down);
      await em.getConnection().execute('DELETE FROM schema_migrations WHERE name=?', [migration.name]);
    });
  } finally {
    await orm.close(true);
  }
}
