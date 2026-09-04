import type { MoneyProps } from '../../shared/domain/money.js';
import type { WagerKind, WagerStatus } from '../domain/wager-transaction.js';

export interface SubmitCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
  correlationId?: string;
}
export interface InboxClaim {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  transportMessageId?: string;
}
export interface SubmitResult {
  transactionId: string;
  status: WagerStatus;
  balance: MoneyProps;
  walletVersion: string;
  failureCode?: string;
  idempotentReplay: boolean;
}
export interface LedgerItem {
  id: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}
