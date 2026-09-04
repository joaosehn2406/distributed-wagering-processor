import { Injectable } from '@nestjs/common';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { DatabaseService } from '../shared/infrastructure/database.service.js';
import { SqsService } from '../messaging/sqs.service.js';
import { loadEnvironment } from '../config/environment.js';

@Injectable()
export class HealthService {
  private readonly env = loadEnvironment();
  constructor(
    private readonly database: DatabaseService,
    private readonly sqs: SqsService,
  ) {}
  async ready(): Promise<{ status: 'ok' }> {
    await this.database.em.getConnection().execute('SELECT 1');
    await this.sqs.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.env.wagerQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    return { status: 'ok' };
  }
}
