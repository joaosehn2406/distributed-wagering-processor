import { HttpException } from '@nestjs/common';
import { DomainError } from '../shared/domain/domain-error.js';

export interface HttpErrorBody {
  code: string;
  message: string;
  correlationId: string;
  retryable: boolean;
}

export interface MappedHttpError {
  status: number;
  body: HttpErrorBody;
}

const notFound = new Set(['WALLET_NOT_FOUND', 'WAGER_TRANSACTION_NOT_FOUND']);
const conflicts = new Set([
  'IDEMPOTENCY_CONFLICT',
  'EXTERNAL_TRANSACTION_CONFLICT',
  'WALLET_ALREADY_EXISTS',
  'INBOX_PAYLOAD_CONFLICT',
]);
const businessRejections = new Set([
  'INSUFFICIENT_FUNDS',
  'ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_CONTEXT_MISMATCH',
  'REFERENCE_KIND_NOT_ALLOWED',
  'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERSED',
  'CURRENCY_MISMATCH',
  'WALLET_PLAYER_MISMATCH',
  'AMOUNT_MUST_BE_POSITIVE',
]);
const invalidPayload = new Set([
  'INVALID_MONEY',
  'MONEY_OUT_OF_RANGE',
  'INVALID_TRANSACTION_KIND',
  'REFERENCE_REQUIRED',
  'INVALID_PAYLOAD',
  'OPENING_NOT_EXTERNAL',
]);
const transient = new Set([
  'NOT_READY',
  'TRANSIENT_UNIQUE_RACE',
  'DELAY_OUT_OF_RANGE',
  'TEMPORARY_UNAVAILABLE',
]);

const statusForDomainCode = (code: string): number => {
  if (notFound.has(code)) return 404;
  if (conflicts.has(code)) return 409;
  if (businessRejections.has(code)) return 422;
  if (invalidPayload.has(code)) return 400;
  if (transient.has(code)) return 503;
  return 503;
};

/** Produces a stable, payload-safe error contract for every HTTP failure. */
export function mapHttpError(exception: unknown, correlationId: string): MappedHttpError {
  if (exception instanceof DomainError) {
    const status = statusForDomainCode(exception.code);
    return {
      status,
      body: {
        code: exception.code,
        message: status >= 500 ? 'temporary dependency failure' : exception.code,
        correlationId,
        retryable: status >= 500,
      },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = status === 400 ? 'INVALID_PAYLOAD' : `HTTP_${status}`;
    return {
      status,
      body: {
        code,
        message: status >= 500 ? 'temporary dependency failure' : code,
        correlationId,
        retryable: status >= 500,
      },
    };
  }
  return {
    status: 503,
    body: {
      code: 'TEMPORARY_UNAVAILABLE',
      message: 'temporary dependency failure',
      correlationId,
      retryable: true,
    },
  };
}
