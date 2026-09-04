import { DomainError } from '../../shared/domain/domain-error.js';
import { Money, type MoneyProps } from '../../shared/domain/money.js';

export type LedgerDirection = 'CREDIT' | 'DEBIT';
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: bigint;
  createdAt: Date;
  updatedAt: Date;
}
export interface BalanceMovement {
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export class Wallet {
  private constructor(private state: WalletState) {}
  static open(input: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (input.initialBalance.isNegative()) throw new DomainError('INVALID_INITIAL_BALANCE');
    const now = input.now ?? new Date();
    return new Wallet({
      id: input.id,
      playerId: input.playerId,
      currency: input.initialBalance.currency,
      balance: input.initialBalance.toJSON(),
      version: 1n,
      createdAt: now,
      updatedAt: now,
    });
  }
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state });
  }
  get id(): string {
    return this.state.id;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get currency(): string {
    return this.state.currency;
  }
  get balance(): Money {
    return Money.fromPersistence(this.state.balance);
  }
  get version(): bigint {
    return this.state.version;
  }
  get createdAt(): Date {
    return this.state.createdAt;
  }
  get updatedAt(): Date {
    return this.state.updatedAt;
  }
  debit(amount: Money, now = new Date()): BalanceMovement {
    this.assertCurrency(amount);
    if (!amount.isPositive()) throw new DomainError('INVALID_MONEY');
    const before = this.balance;
    if (before.isLessThan(amount)) throw new DomainError('INSUFFICIENT_FUNDS');
    const after = before.subtract(amount);
    this.change(after, now);
    return { direction: 'DEBIT', amount, balanceBefore: before, balanceAfter: after };
  }
  credit(amount: Money, now = new Date()): BalanceMovement {
    this.assertCurrency(amount);
    if (!amount.isPositive()) throw new DomainError('INVALID_MONEY');
    const before = this.balance;
    const after = before.add(amount);
    this.change(after, now);
    return { direction: 'CREDIT', amount, balanceBefore: before, balanceAfter: after };
  }
  private change(after: Money, now: Date): void {
    this.state.balance = after.toJSON();
    this.state.version += 1n;
    this.state.updatedAt = now;
  }
  private assertCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
