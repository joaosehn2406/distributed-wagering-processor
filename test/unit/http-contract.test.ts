import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { expect, test } from 'bun:test';
import { CreateWalletDto, SubmitWagerDto } from '../../src/bootstrap/http.dto.js';
import { mapHttpError } from '../../src/bootstrap/http-error.js';
import { DomainError } from '../../src/shared/domain/domain-error.js';

const playerId = '550e8400-e29b-41d4-a716-446655440000';
const walletId = '9f6c31c0-e5df-4db4-b28d-4496cd8c8c66';

test('validates string-decimal HTTP DTOs and rejects numeric money', async () => {
  const validWallet = plainToInstance(CreateWalletDto, {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(await validate(validWallet)).toHaveLength(0);

  const invalidMoney = plainToInstance(SubmitWagerDto, {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: 25, currency: 'BRL' },
  });
  const errors = await validate(invalidMoney);
  expect(errors.some((error) => error.property === 'money')).toBe(true);
});

test('maps invalid payload, business rejection, conflict and readiness to stable HTTP errors', () => {
  expect(mapHttpError(new BadRequestException(), 'correlation-invalid')).toEqual({
    status: 400,
    body: {
      code: 'INVALID_PAYLOAD',
      message: 'INVALID_PAYLOAD',
      correlationId: 'correlation-invalid',
      retryable: false,
    },
  });
  expect(mapHttpError(new DomainError('INSUFFICIENT_FUNDS'), 'correlation-business')).toMatchObject(
    {
      status: 422,
      body: { code: 'INSUFFICIENT_FUNDS', retryable: false },
    },
  );
  expect(
    mapHttpError(new DomainError('IDEMPOTENCY_CONFLICT'), 'correlation-conflict'),
  ).toMatchObject({
    status: 409,
    body: { code: 'IDEMPOTENCY_CONFLICT', retryable: false },
  });
  expect(mapHttpError(new DomainError('NOT_READY'), 'correlation-ready')).toEqual({
    status: 503,
    body: {
      code: 'NOT_READY',
      message: 'temporary dependency failure',
      correlationId: 'correlation-ready',
      retryable: true,
    },
  });
});
