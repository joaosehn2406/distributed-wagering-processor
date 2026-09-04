import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const region = process.env.AWS_REGION ?? 'us-east-1';

export interface TestQueues {
  client: SQSClient;
  wagers: string;
  wagerDlq: string;
  events: string;
}

const queueUrl = async (client: SQSClient, name: string): Promise<string> => {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  if (!result.QueueUrl) throw new Error(`queue ${name} was not created`);
  return result.QueueUrl;
};

export async function createTestQueues(): Promise<TestQueues> {
  const client = new SQSClient({
    region,
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const prefix = `wager-it-${randomUUID().replaceAll('-', '')}`;
  return {
    client,
    wagers: await queueUrl(client, `${prefix}-commands.fifo`),
    wagerDlq: await queueUrl(client, `${prefix}-commands-dlq.fifo`),
    events: await queueUrl(client, `${prefix}-events.fifo`),
  };
}

export async function deleteTestQueues(queues: TestQueues): Promise<void> {
  await Promise.all(
    [queues.wagers, queues.wagerDlq, queues.events].map((QueueUrl) =>
      queues.client.send(new DeleteQueueCommand({ QueueUrl })),
    ),
  );
  queues.client.destroy();
}

export async function receiveOne(client: SQSClient, QueueUrl: string) {
  const result = await client.send(
    new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 2, MaxNumberOfMessages: 1 }),
  );
  return result.Messages?.[0];
}
