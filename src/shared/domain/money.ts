import Decimal from 'decimal.js';
import { DomainError } from './domain-error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const CONTRACT_AMOUNT = /^(0|[1-9]\d*)\.\d{2}$/;
const PERSISTED_AMOUNT = /^-?(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_INTEGER_DIGITS = 18;

/** Exact, immutable money. Decimal never crosses an adapter boundary. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static fromContract(props: MoneyProps): Money {
    if (!CONTRACT_AMOUNT.test(props.amount) || !CURRENCY.test(props.currency)) {
      throw new DomainError('INVALID_MONEY', 'amount must be a non-negative xx.xx decimal');
    }
    return Money.fromValidated(props.amount, props.currency);
  }

  static fromPersistence(props: MoneyProps): Money {
    if (!PERSISTED_AMOUNT.test(props.amount) || !CURRENCY.test(props.currency)) {
      throw new DomainError('INVALID_PERSISTED_MONEY');
    }
    return Money.fromValidated(props.amount, props.currency);
  }

  static zero(currency: string): Money {
    return Money.fromContract({ amount: '0.00', currency });
  }

  private static fromValidated(amount: string, currency: string): Money {
    const unsigned = amount.startsWith('-') ? amount.slice(1) : amount;
    if (unsigned.split('.')[0].length > MAX_INTEGER_DIGITS)
      throw new DomainError('MONEY_OUT_OF_RANGE');
    return new Money(new Decimal(amount), currency);
  }

  add(other: Money): Money {
    this.sameCurrency(other);
    return Money.fromPersistence({
      amount: this.value.plus(other.value).toFixed(2),
      currency: this.currency,
    });
  }
  subtract(other: Money): Money {
    this.sameCurrency(other);
    return Money.fromPersistence({
      amount: this.value.minus(other.value).toFixed(2),
      currency: this.currency,
    });
  }
  negate(): Money {
    return Money.fromPersistence({
      amount: this.value.negated().toFixed(2),
      currency: this.currency,
    });
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }
  isNegative(): boolean {
    return this.value.isNegative();
  }
  isLessThan(other: Money): boolean {
    this.sameCurrency(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    this.sameCurrency(other);
    return this.value.equals(other.value);
  }
  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }
  toString(): string {
    return this.value.toFixed(2);
  }
  private sameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
