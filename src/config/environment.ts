import { DomainError } from '../shared/domain/domain-error.js';

export type AppRole = 'api' | 'sqs-consumer' | 'outbox-publisher' | 'pending-worker' | 'all';
export interface Environment {
  role: AppRole;
  appInstanceId: string;
  port: number;
  metricsPort?: number;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  wagerQueueUrl: string;
  wagerDlqQueueUrl: string;
  walletEventsQueueUrl: string;
  pendingMaxAttempts: bigint;
  pendingTtlSeconds: bigint;
  pendingBackoffBaseSeconds: bigint;
  pendingBackoffMaxSeconds: bigint;
  pendingClaimSeconds: bigint;
  pendingBatchSize: bigint;
  pendingPollMilliseconds: bigint;
  outboxBackoffBaseSeconds: bigint;
  outboxBackoffMaxSeconds: bigint;
  outboxLeaseSeconds: bigint;
  outboxBatchSize: bigint;
  outboxPollMilliseconds: bigint;
  sqsVisibilityTimeoutSeconds: bigint;
  sqsLongPollSeconds: bigint;
  sqsBatchSize: bigint;
  sqsMaxReceiveAttempts: bigint;
  sqsRetryBackoffBaseSeconds: bigint;
  sqsRetryBackoffMaxSeconds: bigint;
  consumerShutdownSeconds: bigint;
  crashAfterCommitBeforeAckMessageId?: string;
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
function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' || value === undefined ? undefined : value;
}
function port(name: string, value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value))
    throw new DomainError('INVALID_CONFIGURATION', `${name} must be a valid port`);
  const parsed = Number(value);
  if (parsed > 65_535)
    throw new DomainError('INVALID_CONFIGURATION', `${name} must be a valid port`);
  return parsed;
}
export function loadEnvironment(): Environment {
  const role = (process.env.APP_ROLE ?? 'all') as AppRole;
  if (!roles.has(role)) throw new DomainError('INVALID_CONFIGURATION', 'APP_ROLE is invalid');
  const metricsPort = optional('METRICS_PORT');
  const environment: Environment = {
    role,
    appInstanceId: required('APP_INSTANCE_ID', 'local'),
    port: port('PORT', required('PORT', '3000')),
    metricsPort: metricsPort ? port('METRICS_PORT', metricsPort) : undefined,
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
    pendingBackoffBaseSeconds: whole('PENDING_BACKOFF_BASE_SECONDS', '5'),
    pendingBackoffMaxSeconds: whole('PENDING_BACKOFF_MAX_SECONDS', '3600'),
    pendingClaimSeconds: whole('PENDING_CLAIM_SECONDS', '60'),
    pendingBatchSize: whole('PENDING_BATCH_SIZE', '25'),
    pendingPollMilliseconds: whole('PENDING_POLL_MILLISECONDS', '1000'),
    outboxBackoffBaseSeconds: whole('OUTBOX_BACKOFF_BASE_SECONDS', '1'),
    outboxBackoffMaxSeconds: whole('OUTBOX_BACKOFF_MAX_SECONDS', '300'),
    outboxLeaseSeconds: whole('OUTBOX_LEASE_SECONDS', '60'),
    outboxBatchSize: whole('OUTBOX_BATCH_SIZE', '25'),
    outboxPollMilliseconds: whole('OUTBOX_POLL_MILLISECONDS', '500'),
    sqsVisibilityTimeoutSeconds: whole('SQS_VISIBILITY_TIMEOUT_SECONDS', '60'),
    sqsLongPollSeconds: whole('SQS_LONG_POLL_SECONDS', '10'),
    sqsBatchSize: whole('SQS_BATCH_SIZE', '10'),
    sqsMaxReceiveAttempts: whole('SQS_MAX_RECEIVE_ATTEMPTS', '5'),
    sqsRetryBackoffBaseSeconds: whole('SQS_RETRY_BACKOFF_BASE_SECONDS', '1'),
    sqsRetryBackoffMaxSeconds: whole('SQS_RETRY_BACKOFF_MAX_SECONDS', '60'),
    consumerShutdownSeconds: whole('CONSUMER_SHUTDOWN_SECONDS', '30'),
    crashAfterCommitBeforeAckMessageId: optional('CRASH_AFTER_COMMIT_BEFORE_ACK_MESSAGE_ID'),
  };
  if (
    environment.pendingBackoffMaxSeconds < environment.pendingBackoffBaseSeconds ||
    environment.outboxBackoffMaxSeconds < environment.outboxBackoffBaseSeconds ||
    environment.sqsRetryBackoffMaxSeconds < environment.sqsRetryBackoffBaseSeconds
  )
    throw new DomainError('INVALID_CONFIGURATION', 'backoff max must not be lower than base');
  if (environment.sqsBatchSize > 10n)
    throw new DomainError('INVALID_CONFIGURATION', 'SQS_BATCH_SIZE must not exceed 10');
  if (environment.sqsLongPollSeconds > 20n)
    throw new DomainError('INVALID_CONFIGURATION', 'SQS_LONG_POLL_SECONDS must not exceed 20');
  if (
    environment.sqsVisibilityTimeoutSeconds > 43_200n ||
    environment.sqsRetryBackoffMaxSeconds > 43_200n
  )
    throw new DomainError(
      'INVALID_CONFIGURATION',
      'SQS visibility and retry backoff must not exceed 43200',
    );
  if (
    environment.crashAfterCommitBeforeAckMessageId !== undefined &&
    process.env.RUN_CRASH_TEST !== 'true'
  )
    throw new DomainError(
      'INVALID_CONFIGURATION',
      'CRASH_AFTER_COMMIT_BEFORE_ACK_MESSAGE_ID requires RUN_CRASH_TEST=true',
    );
  return environment;
}
