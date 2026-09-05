import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  async dlq(body: string, messageId: string, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.env.wagerDlqQueueUrl,
        MessageBody: body,
        MessageGroupId: 'invalid-envelope',
        // Envelope message IDs may be 255 chars while SQS FIFO accepts at most
        // 128 chars for a deduplication ID. Keep the original in attributes.
        MessageDeduplicationId: createHash('sha256')
          .update(`dlq:${reason}:${messageId}`, 'utf8')
          .digest('hex'),
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          logicalMessageId: { DataType: 'String', StringValue: messageId },
        },
      }),
    );
  }
}
