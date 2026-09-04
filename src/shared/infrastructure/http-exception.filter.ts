import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../domain/domain-error.js';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = String(
      host.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers[
        'x-correlation-id'
      ] ?? crypto.randomUUID(),
    );
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const code = exception instanceof DomainError ? exception.code : 'TEMPORARY_UNAVAILABLE';
    const status = ['WALLET_NOT_FOUND', 'WAGER_TRANSACTION_NOT_FOUND'].includes(code)
      ? 404
      : [
            'IDEMPOTENCY_CONFLICT',
            'EXTERNAL_TRANSACTION_CONFLICT',
            'WALLET_ALREADY_EXISTS',
            'INBOX_PAYLOAD_CONFLICT',
          ].includes(code)
        ? 409
        : [
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
            ].includes(code)
          ? 422
          : [
                'INVALID_MONEY',
                'INVALID_TRANSACTION_KIND',
                'REFERENCE_REQUIRED',
                'INVALID_PAYLOAD',
              ].includes(code)
            ? 400
            : 503;
    response.status(status).json({
      code,
      message: status === 503 ? 'temporary dependency failure' : code,
      correlationId,
    });
  }
}
