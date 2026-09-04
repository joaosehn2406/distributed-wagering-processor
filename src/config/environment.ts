import { DomainError } from '../shared/domain/domain-error.js';

export type AppRole = 'api' | 'sqs-consumer' | 'outbox-publisher' | 'pending-worker' | 'all';
export interface Environment {
  role: AppRole;
  port: number;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  wagerQueueUrl: string;
  wagerDlqQueueUrl: string;
  walletEventsQueueUrl: string;
  pendingMaxAttempts: bigint;
  pendingTtlSeconds: bigint;
}
const roles = new Set<AppRole>([
  'api',
  'sqs-consumer',
  'outbox-publisher',
  'pending-worker',
  'all',
]);
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new DomainError('INVALID_CONFIGURATION', `${name} is required`);
  return value;
}
function whole(name: string, fallback: string): bigint {
  const raw = required(name, fallback);
  if (!/^\d+$/.test(raw) || raw === '0')
    throw new DomainError('INVALID_CONFIGURATION', `${name} must be a positive integer`);
  return BigInt(raw);
}
export function loadEnvironment(): Environment {
  const role = (process.env.APP_ROLE ?? 'all') as AppRole;
  if (!roles.has(role)) throw new DomainError('INVALID_CONFIGURATION', 'APP_ROLE is invalid');
  return {
    role,
    port: Number.parseInt(required('PORT', '3000'), 10),
    databaseUrl: required('DATABASE_URL', 'postgresql://wager:wager@localhost:5432/wagering'),
    sqsEndpoint: required('SQS_ENDPOINT', 'http://localhost:4566'),
    awsRegion: required('AWS_REGION', 'us-east-1'),
    wagerQueueUrl: required(
      'WAGER_QUEUE_URL',
      'http://localhost:4566/000000000000/wager-transactions.fifo',
    ),
    wagerDlqQueueUrl: required(
      'WAGER_DLQ_QUEUE_URL',
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    ),
    walletEventsQueueUrl: required(
      'WALLET_EVENTS_QUEUE_URL',
      'http://localhost:4566/000000000000/wallet-events.fifo',
    ),
    pendingMaxAttempts: whole('PENDING_MAX_ATTEMPTS', '10'),
    pendingTtlSeconds: whole('PENDING_TTL_SECONDS', '86400'),
  };
}
