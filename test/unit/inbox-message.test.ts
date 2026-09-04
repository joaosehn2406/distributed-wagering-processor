import { expect, test } from 'bun:test';
import { InboxMessage } from '../../src/messaging/domain/inbox-message.js';

test('models a persistent inbox delivery without an in-memory deduplication cache', () => {
  const receivedAt = new Date('2026-09-04T00:00:00.000Z');
  const inbox = InboxMessage.receive({
    consumerName: 'wager-transaction-consumer-v1',
    messageId: 'logical-message-id',
    payloadHash: 'a'.repeat(64),
    transportMessageId: 'sqs-message-id',
    receivedAt,
  });

  expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(new Date('2026-09-04T00:00:01.000Z'));
  inbox.markProcessed(new Date('2026-09-04T00:00:02.000Z'));
  expect(inbox.snapshot).toMatchObject({
    consumerName: 'wager-transaction-consumer-v1',
    messageId: 'logical-message-id',
    transportMessageId: 'sqs-message-id',
    receivedAt,
    processedAt: new Date('2026-09-04T00:00:01.000Z'),
  });
});
