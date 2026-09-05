import type { MoneyProps } from '../../../shared/domain/money.js';
import type { BalanceMovement, Wallet } from '../../../wallet/domain/wallet.js';
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../outbox/domain/integration-event.js';
import type { WagerTransaction } from '../wager-transaction.js';

export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}

interface WagerEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceTransactionId?: string;
}

function wagerData(transaction: WagerTransaction): WagerEventData {
  const state = transaction.snapshot;
  return {
    transactionId: state.id,
    providerId: state.providerId,
    externalTransactionId: state.externalTransactionId,
    walletId: state.walletId,
    kind: state.kind,
    money: state.money.toJSON(),
    status: state.status,
    ...(state.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: state.referenceTransactionId }),
  };
}

export class WagerTransactionProcessedEvent extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionProcessedEvent {
    const state = transaction.snapshot;
    return new WagerTransactionProcessedEvent({
      aggregateId: state.walletId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: wagerData(transaction),
    });
  }

  private constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
  }
}

interface WagerRejectedData extends WagerEventData {
  failureCode: string;
}

export class WagerTransactionRejectedEvent extends IntegrationEvent<WagerRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejectedEvent {
    const state = transaction.snapshot;
    if (!state.failureCode) throw new Error('rejected wager requires a failure code');
    return new WagerTransactionRejectedEvent({
      aggregateId: state.walletId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: { ...wagerData(transaction), failureCode: state.failureCode },
    });
  }

  private constructor(props: IntegrationEventProps<WagerRejectedData>) {
    super(props);
  }
}

interface WagerPendingReferenceData extends WagerEventData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<WagerPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReferenceEvent {
    const state = transaction.snapshot;
    if (!state.referenceExternalTransactionId || !state.nextReferenceAttemptAt)
      throw new Error('pending wager requires a reference and next attempt');
    return new WagerTransactionPendingReferenceEvent({
      aggregateId: state.walletId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: {
        ...wagerData(transaction),
        referenceExternalTransactionId: state.referenceExternalTransactionId,
        nextAttemptAt: state.nextReferenceAttemptAt.toISOString(),
      },
    });
  }

  private constructor(props: IntegrationEventProps<WagerPendingReferenceData>) {
    super(props);
  }
}

interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: string;
}

export class WalletBalanceChangedEvent extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    transaction: WagerTransaction,
    movement: BalanceMovement,
    context: EventContext,
  ): WalletBalanceChangedEvent {
    return new WalletBalanceChangedEvent({
      aggregateId: wallet.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: movement.direction,
        money: movement.amount.toJSON(),
        balanceBefore: movement.balanceBefore.toJSON(),
        balanceAfter: movement.balanceAfter.toJSON(),
        walletVersion: wallet.version.toString(),
      },
    });
  }

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }
}
