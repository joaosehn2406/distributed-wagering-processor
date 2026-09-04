import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { mapHttpError } from '../../bootstrap/http-error.js';
import type { CorrelatedRequest } from '../../bootstrap/correlation.middleware.js';
import { writeJsonLog } from './structured-logger.js';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<CorrelatedRequest>();
    const correlationId = request.correlationId ?? randomUUID();
    const mapped = mapHttpError(exception, correlationId);
    writeJsonLog(mapped.status >= 500 ? 'error' : 'warn', 'http.request_failed', {
      correlationId,
      component: 'http',
      code: mapped.body.code,
      retryable: mapped.body.retryable,
    });
    response.status(mapped.status).json(mapped.body);
  }
}
