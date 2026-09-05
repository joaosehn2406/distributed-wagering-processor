import { randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import type { LedgerDirection } from './wallet.js';

export interface WalletLedgerEntryProps {
  id?: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

/**
 * Immutable, validated representation of one auditable wallet movement.
 * PostgreSQL repeats these checks because this class is not a trust boundary.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(input: WalletLedgerEntryProps): WalletLedgerEntry {
    if (!input.money.isPositive()) throw new DomainError('INVALID_MONEY');
    if (
      input.money.currency !== input.balanceBefore.currency ||
      input.money.currency !== input.balanceAfter.currency
    )
      throw new DomainError('CURRENCY_MISMATCH');
    if (input.balanceBefore.isNegative() || input.balanceAfter.isNegative())
      throw new DomainError('NEGATIVE_BALANCE');
    const expected =
      input.direction === 'CREDIT'
        ? input.balanceBefore.add(input.money)
        : input.balanceBefore.subtract(input.money);
    if (!expected.equals(input.balanceAfter)) throw new DomainError('INVALID_LEDGER_ARITHMETIC');
    return new WalletLedgerEntry(
      input.id ?? randomUUID(),
      input.walletId,
      input.transactionId,
      input.direction,
      input.money,
      input.balanceBefore,
      input.balanceAfter,
      input.createdAt ?? new Date(),
    );
  }

  static rehydrate(input: Required<WalletLedgerEntryProps>): WalletLedgerEntry {
    return new WalletLedgerEntry(
      input.id,
      input.walletId,
      input.transactionId,
      input.direction,
      input.money,
      input.balanceBefore,
      input.balanceAfter,
      input.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === 'CREDIT'
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return !this.balanceAfter.isNegative() && expected.equals(this.balanceAfter);
  }
}
