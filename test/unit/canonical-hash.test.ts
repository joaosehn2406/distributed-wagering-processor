import { expect, test } from 'bun:test';
import { businessFieldsOf, payloadHash } from '../../src/shared/application/canonical-hash.js';
import { Money } from '../../src/shared/domain/money.js';

test('hash excludes transport identity and canonically represents null references', () => {
  const fields = businessFieldsOf({
    providerId: 'provider',
    externalTransactionId: 'external',
    playerId: 'player',
    walletId: 'wallet',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: Money.fromContract({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
  });
  expect(fields.referenceExternalTransactionId).toBeNull();
  expect(payloadHash(fields)).toMatch(/^[a-f0-9]{64}$/);
});
