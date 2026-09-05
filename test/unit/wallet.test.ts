import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../src/wallet/domain/wallet.js';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.js';
import { Money } from '../../src/shared/domain/money.js';

describe('Wallet', () => {
  test('opens a zero-balance wallet at version one without a balance movement', () => {
    const w = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: Money.fromContract({ amount: '0.00', currency: 'BRL' }),
    });
    expect(w.balance.toString()).toBe('0.00');
    expect(w.version).toBe(1n);
  });
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
  test('creates an immutable and balanced ledger entry', () => {
    const before = Money.fromContract({ amount: '100.00', currency: 'BRL' });
    const money = Money.fromContract({ amount: '25.00', currency: 'BRL' });
    const after = Money.fromContract({ amount: '75.00', currency: 'BRL' });
    const entry = WalletLedgerEntry.create({
      walletId: 'wallet',
      transactionId: 'transaction',
      direction: 'DEBIT',
      money,
      balanceBefore: before,
      balanceAfter: after,
    });
    expect(entry.isBalanced()).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'wallet',
        transactionId: 'invalid-transaction',
        direction: 'DEBIT',
        money,
        balanceBefore: before,
        balanceAfter: before,
      }),
    ).toThrow('INVALID_LEDGER_ARITHMETIC');
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'wallet',
        transactionId: 'wrong-currency',
        direction: 'CREDIT',
        money,
        balanceBefore: before,
        balanceAfter: Money.fromContract({ amount: '125.00', currency: 'USD' }),
      }),
    ).toThrow('CURRENCY_MISMATCH');
  });
});
