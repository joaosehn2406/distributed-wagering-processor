import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money.js';
import { Wallet } from '../../src/wallet/domain/wallet.js';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.js';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction.js';
import {
  WalletBalanceChangedEvent,
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
} from '../../src/wagering/domain/events/wager-events.js';
import { OutboxMessage } from '../../src/outbox/domain/outbox-message.js';

test('serializes a versioned event envelope with decimal-string money', () => {
  const wallet = Wallet.open({
    id: 'wallet-id',
    playerId: 'player-id',
    initialBalance: Money.fromContract({ amount: '100.00', currency: 'BRL' }),
  });
  const transaction = WagerTransaction.create(
    {
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      idempotencyKey: 'provider-a:bet-1',
      payloadHash: 'a'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'BET',
      money: Money.fromContract({ amount: '25.00', currency: 'BRL' }),
    },
    'transaction-id',
  );
  const movement = wallet.debit(Money.fromContract({ amount: '25.00', currency: 'BRL' }));
  transaction.processed(wallet.balance, wallet.version);
  const entry = WalletLedgerEntry.create({
    walletId: wallet.id,
    transactionId: transaction.id,
    direction: movement.direction,
    money: movement.amount,
    balanceBefore: movement.balanceBefore,
    balanceAfter: movement.balanceAfter,
  });

  const event = WalletBalanceChangedEvent.from(wallet, transaction, entry, {
    correlationId: 'correlation-id',
    causationId: 'message-id',
    occurredAt: new Date('2026-09-04T00:00:00.000Z'),
  });
  const envelope = event.toJSON();
  const message = OutboxMessage.enqueue(event);

  expect(envelope).toMatchObject({
    eventType: 'WalletBalanceChanged',
    version: 1,
    aggregateId: 'wallet-id',
    correlationId: 'correlation-id',
    causationId: 'message-id',
    occurredAt: '2026-09-04T00:00:00.000Z',
    data: {
      transactionId: 'transaction-id',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: '2',
    },
  });
  expect(message.snapshot.payload).toEqual(envelope);
  expect(message.snapshot.eventVersion).toBe(1);
  expect(message.isDue(new Date('2026-09-04T00:00:00.000Z'))).toBe(true);
  message.scheduleRetry(new Date('2026-09-04T00:01:00.000Z'), 'SQS_PUBLISH_FAILED');
  expect(message.snapshot.attempts).toBe(1n);
  expect(message.isDue(new Date('2026-09-04T00:00:30.000Z'))).toBe(false);
  message.markPublished(new Date('2026-09-04T00:01:00.000Z'));
  expect(message.isPending()).toBe(false);
});

test('processed wager event preserves its typed envelope', () => {
  const transaction = WagerTransaction.create(
    {
      providerId: 'provider-a',
      externalTransactionId: 'loss-1',
      idempotencyKey: 'provider-a:loss-1',
      payloadHash: 'b'.repeat(64),
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'LOSS',
      money: Money.fromContract({ amount: '25.00', currency: 'BRL' }),
    },
    'loss-transaction-id',
  );
  transaction.processed(Money.fromContract({ amount: '75.00', currency: 'BRL' }), 2n);

  const processedEnvelope = WagerTransactionProcessedEvent.from(transaction, {
    correlationId: 'correlation-id',
  }).toJSON();
  expect(processedEnvelope).toMatchObject({
    eventType: 'WagerTransactionProcessed',
    version: 1,
    aggregateId: 'wallet-id',
    data: {
      transactionId: 'loss-transaction-id',
      kind: 'LOSS',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
    },
  });
});

test('pending and rejected wagers have distinct typed event envelopes', () => {
  const pending = WagerTransaction.create(
    {
      providerId: 'provider-a',
      externalTransactionId: 'refund-before-bet',
      idempotencyKey: 'provider-a:refund-before-bet',
      payloadHash: 'c'.repeat(64),
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'REFUND',
      money: Money.fromContract({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-later',
    },
    'pending-transaction-id',
  );
  pending.pendingReference(
    Money.fromContract({ amount: '75.00', currency: 'BRL' }),
    2n,
    new Date('2026-09-04T00:01:00.000Z'),
    new Date('2026-09-05T00:00:00.000Z'),
  );
  const rejected = WagerTransaction.create(
    {
      providerId: 'provider-a',
      externalTransactionId: 'bet-insufficient',
      idempotencyKey: 'provider-a:bet-insufficient',
      payloadHash: 'd'.repeat(64),
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'BET',
      money: Money.fromContract({ amount: '100.00', currency: 'BRL' }),
    },
    'rejected-transaction-id',
  );
  rejected.rejected(
    'INSUFFICIENT_FUNDS',
    Money.fromContract({ amount: '75.00', currency: 'BRL' }),
    2n,
  );

  const pendingEnvelope = WagerTransactionPendingReferenceEvent.from(pending, {
    correlationId: 'correlation-id',
  }).toJSON();
  expect(pendingEnvelope).toMatchObject({
    eventType: 'WagerTransactionPendingReference',
    version: 1,
    data: {
      referenceExternalTransactionId: 'bet-later',
      nextAttemptAt: '2026-09-04T00:01:00.000Z',
    },
  });
  const rejectedEnvelope = WagerTransactionRejectedEvent.from(rejected, {
    correlationId: 'correlation-id',
  }).toJSON();
  expect(rejectedEnvelope).toMatchObject({
    eventType: 'WagerTransactionRejected',
    version: 1,
    data: { failureCode: 'INSUFFICIENT_FUNDS', status: 'REJECTED' },
  });
});
