import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../src/wallet/domain/wallet.js';
import { Money } from '../../src/shared/domain/money.js';

describe('Wallet', () => {
  test('starts at version one and increments only when balance changes', () => {
    const w = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: Money.fromContract({ amount: '100.00', currency: 'BRL' }),
    });
    expect(w.version).toBe(1n);
    const entry = w.debit(Money.fromContract({ amount: '80.00', currency: 'BRL' }));
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(w.version).toBe(2n);
  });
  test('never permits a negative balance', () => {
    const w = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: Money.fromContract({ amount: '10.00', currency: 'BRL' }),
    });
    expect(() => w.debit(Money.fromContract({ amount: '10.01', currency: 'BRL' }))).toThrow(
      'INSUFFICIENT_FUNDS',
    );
  });
});
