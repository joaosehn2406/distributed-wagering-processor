import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money.js';
import { DomainError } from '../../src/shared/domain/domain-error.js';

describe('Money', () => {
  test('keeps exact fixed-scale decimal arithmetic', () => {
    const a = Money.fromContract({ amount: '0.10', currency: 'BRL' });
    const b = Money.fromContract({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });
  test('rejects noncanonical public values', () => {
    for (const amount of ['1', '01.00', '1.0', '1.000', '-1.00', '1e2', ''])
      expect(() => Money.fromContract({ amount, currency: 'BRL' })).toThrow(DomainError);
  });
  test('rejects a value outside NUMERIC(20,2)', () => {
    expect(() => Money.fromContract({ amount: '1000000000000000000.00', currency: 'BRL' })).toThrow(
      'MONEY_OUT_OF_RANGE',
    );
  });
  test('does not mix currencies', () => {
    expect(() =>
      Money.fromContract({ amount: '1.00', currency: 'BRL' }).add(
        Money.fromContract({ amount: '1.00', currency: 'USD' }),
      ),
    ).toThrow('CURRENCY_MISMATCH');
  });
});
