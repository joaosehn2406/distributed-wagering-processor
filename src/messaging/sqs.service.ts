import { Injectable } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadEnvironment } from '../config/environment.js';

@Injectable()
export class SqsService {
  private readonly env = loadEnvironment();
  readonly client = new SQSClient({
    region: this.env.awsRegion,
    endpoint: this.env.sqsEndpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  async event(body: Record<string, unknown>, eventId: string, walletId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.env.walletEventsQueueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: walletId,
        MessageDeduplicationId: eventId,
      }),
    );
  }
  async dlq(body: string, messageId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.env.wagerDlqQueueUrl,
        MessageBody: body,
        MessageGroupId: 'invalid-envelope',
        MessageDeduplicationId: messageId,
      }),
    );
  }
}
