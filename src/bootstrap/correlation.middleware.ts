import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export interface CorrelatedRequest extends Request {
  correlationId?: string;
}

const headerValue = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: CorrelatedRequest, response: Response, next: NextFunction): void {
    const correlationId = headerValue(request.headers['x-correlation-id']) ?? randomUUID();
    request.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    next();
  }
}

export const correlationIdOf = (request: CorrelatedRequest): string =>
  request.correlationId ?? randomUUID();
