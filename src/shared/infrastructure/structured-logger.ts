import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Deliberately excludes money and raw payloads from structured log context. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  component?: string;
  status?: string;
  code?: string;
  retryable?: boolean;
}

export function jsonLogLine(level: LogLevel, event: string, context: LogContext = {}): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    correlationId: context.correlationId ?? randomUUID(),
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
    ...(context.transactionId === undefined ? {} : { transactionId: context.transactionId }),
    ...(context.walletId === undefined ? {} : { walletId: context.walletId }),
    ...(context.providerId === undefined ? {} : { providerId: context.providerId }),
    ...(context.component === undefined ? {} : { component: context.component }),
    ...(context.status === undefined ? {} : { status: context.status }),
    ...(context.code === undefined ? {} : { code: context.code }),
    ...(context.retryable === undefined ? {} : { retryable: context.retryable }),
  });
}

export function writeJsonLog(level: LogLevel, event: string, context: LogContext = {}): void {
  process.stdout.write(`${jsonLogLine(level, event, context)}\n`);
}
