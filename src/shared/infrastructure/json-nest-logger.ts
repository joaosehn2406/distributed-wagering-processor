import type { LoggerService } from '@nestjs/common';
import { writeJsonLog } from './structured-logger.js';

/** Prevents framework logging from accidentally serializing request payloads. */
export class JsonNestLogger implements LoggerService {
  log(_message: unknown, context?: string): void {
    writeJsonLog('info', 'framework.log', { component: context });
  }

  error(_message: unknown, _trace?: string, context?: string): void {
    writeJsonLog('error', 'framework.error', { component: context });
  }

  warn(_message: unknown, context?: string): void {
    writeJsonLog('warn', 'framework.warn', { component: context });
  }

  debug(_message: unknown, context?: string): void {
    writeJsonLog('debug', 'framework.debug', { component: context });
  }

  verbose(_message: unknown, context?: string): void {
    writeJsonLog('debug', 'framework.verbose', { component: context });
  }
}
