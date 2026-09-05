import { Injectable } from '@nestjs/common';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { DatabaseService } from '../shared/infrastructure/database.service.js';
import { SqsService } from '../messaging/sqs.service.js';
import { loadEnvironment } from '../config/environment.js';
import { DomainError } from '../shared/domain/domain-error.js';
import { writeJsonLog } from '../shared/infrastructure/structured-logger.js';

@Injectable()
export class HealthService {
  private readonly env = loadEnvironment();
  constructor(
    private readonly database: DatabaseService,
    private readonly sqs: SqsService,
  ) {}
  async ready(): Promise<{
    status: 'ok';
    checks: { postgres: 'ok'; wagerQueue: 'ok'; wagerDlq: 'ok'; walletEventsQueue: 'ok' };
  }> {
    try {
      await this.database.em.execute('SELECT 1');
      await Promise.all(
        [this.env.wagerQueueUrl, this.env.wagerDlqQueueUrl, this.env.walletEventsQueueUrl].map(
          async (QueueUrl) =>
            this.sqs.client.send(
              new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
            ),
        ),
      );
      return {
        status: 'ok',
        checks: {
          postgres: 'ok',
          wagerQueue: 'ok',
          wagerDlq: 'ok',
          walletEventsQueue: 'ok',
        },
      };
    } catch {
      writeJsonLog('error', 'health.not_ready', { component: 'health', code: 'NOT_READY' });
      throw new DomainError('NOT_READY');
    }
  }
}
