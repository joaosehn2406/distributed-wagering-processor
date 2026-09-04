import { loadEnvironment } from '../config/environment.js';
import { runMigrations, type MigrationCommand } from './migration-runner.js';

export { runMigrations } from './migration-runner.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down')
    throw new Error('Usage: bun src/migrations/run.ts up|down');
  await runMigrations(loadEnvironment().databaseUrl, command as MigrationCommand);
}

if (/[\\/]run\.(?:ts|js)$/.test(process.argv[1] ?? '')) void main();
