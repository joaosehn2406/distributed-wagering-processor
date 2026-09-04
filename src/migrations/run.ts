import { MikroORM } from '@mikro-orm/postgresql';
import { migration0001 } from './Migration0001Initial.js';
import { loadEnvironment } from '../config/environment.js';
import { SchemaMigrationEntity } from '../shared/infrastructure/schema-migration.entity.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down')
    throw new Error('Usage: bun src/migrations/run.ts up|down');
  const orm = await MikroORM.init({
    clientUrl: loadEnvironment().databaseUrl,
    entities: [SchemaMigrationEntity],
  });
  try {
    const connection = orm.em.getConnection();
    if (command === 'up') {
      await connection.execute(migration0001.up);
      await connection.execute(
        'INSERT INTO schema_migrations(name) VALUES (?) ON CONFLICT DO NOTHING',
        [migration0001.name],
      );
    } else {
      await connection.execute(migration0001.down);
    }
  } finally {
    await orm.close(true);
  }
}
void main();
