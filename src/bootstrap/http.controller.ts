import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CreateWalletUseCase } from '../wallet/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../wallet/application/reconcile-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from '../wagering/application/submit-wager-transaction.use-case.js';
import { WagerRepository } from '../wagering/infrastructure/wager.repository.js';
import { DatabaseService } from '../shared/infrastructure/database.service.js';
import { DomainError } from '../shared/domain/domain-error.js';
import type { WagerKind } from '../wagering/domain/wager-transaction.js';
import { HealthService } from '../health/health.service.js';
import { MetricsService } from '../shared/infrastructure/metrics.service.js';

type WalletBody = { playerId: string; initialBalance: { amount: string; currency: string } };
type WagerBody = {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | null;
};
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function assertText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new DomainError('INVALID_PAYLOAD', `${name} is required`);
  return value;
}

function transactionJson(tx: Awaited<ReturnType<typeof WagerRepository.findByProviderExternal>>) {
  if (!tx) throw new DomainError('WAGER_TRANSACTION_NOT_FOUND');
  const s = tx.snapshot;
  return {
    transactionId: s.id,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    walletId: s.walletId,
    playerId: s.playerId,
    roundId: s.roundId,
    gameId: s.gameId,
    kind: s.kind,
    money: s.money.toJSON(),
    referenceExternalTransactionId: s.referenceExternalTransactionId ?? null,
    referenceTransactionId: s.referenceTransactionId ?? null,
    status: s.status,
    failureCode: s.failureCode ?? null,
    acceptedBalance: s.acceptedBalance ?? null,
    acceptedVersion: s.acceptedVersion?.toString() ?? null,
    resultBalance: s.resultBalance ?? null,
    resultVersion: s.resultVersion?.toString() ?? null,
    createdAt: s.createdAt,
    processedAt: s.processedAt ?? null,
  };
}

@Controller()
export class HttpController {
  constructor(
    private readonly wallets: CreateWalletUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly database: DatabaseService,
    private readonly health: HealthService,
    private readonly metrics: MetricsService,
  ) {}
  @Post('wallets') async createWallet(@Body() body: WalletBody, @Res() response: Response) {
    assertText(body?.playerId, 'playerId');
    if (!isUuid(body.playerId)) throw new DomainError('INVALID_PAYLOAD');
    const value = await this.wallets.execute(body);
    return response.status(201).json({ ...value, version: BigInt(value.version).toString() });
  }
  @Get('wallets/:walletId') async wallet(@Param('walletId') id: string) {
    const wallet = await WagerRepository.findWallet(this.database.em, id);
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version.toString(),
    };
  }
  @Get('wallets/:walletId/ledger') async ledger(
    @Param('walletId') id: string,
    @Query('limit') rawLimit?: string,
    @Query('cursor') rawCursor?: string,
  ) {
    const limit = rawLimit === undefined ? 50n : BigInt(rawLimit);
    if (limit < 1n || limit > 100n) throw new DomainError('INVALID_PAYLOAD');
    let cursor: { createdAt: Date; id: string } | undefined;
    if (rawCursor) {
      try {
        const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as {
          createdAt: string;
          id: string;
        };
        if (!parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error('invalid');
        cursor = { id: parsed.id, createdAt: new Date(parsed.createdAt) };
      } catch {
        throw new DomainError('INVALID_PAYLOAD', 'invalid ledger cursor');
      }
    }
    const items = await WagerRepository.ledger(this.database.em, id, limit, cursor);
    const last = items.at(-1);
    return {
      items,
      nextCursor: last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
            'utf8',
          ).toString('base64url')
        : null,
    };
  }
  @Post('wallets/:walletId/reconciliation') async reconciliation(@Param('walletId') id: string) {
    return this.reconcile.execute(id);
  }
  @Post('wagering/transactions') async wager(
    @Body() body: WagerBody,
    @Headers('idempotency-key') key: string | undefined,
    @Res() response: Response,
  ) {
    const idempotencyKey = assertText(key, 'Idempotency-Key');
    for (const field of [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
    ] as const)
      assertText(body?.[field], field);
    const result = await this.submit.submit({ ...body, idempotencyKey });
    if (!result) throw new DomainError('INVALID_TRANSACTION_STATE');
    const status =
      result.status === 'PENDING_REFERENCE'
        ? 202
        : result.status === 'REJECTED'
          ? 422
          : result.idempotentReplay
            ? 200
            : 201;
    return response.status(status).json(result);
  }
  @Get('wagering/transactions/:transactionId') async findTransaction(
    @Param('transactionId') id: string,
  ) {
    return transactionJson(await WagerRepository.findById(this.database.em, id));
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId') async findExternal(
    @Param('providerId') provider: string,
    @Param('externalTransactionId') external: string,
  ) {
    return transactionJson(
      await WagerRepository.findByProviderExternal(this.database.em, provider, external),
    );
  }
  @Get('health/live') @HttpCode(200) live() {
    return { status: 'ok' };
  }
  @Get('health/ready') async ready() {
    return this.health.ready();
  }
  @Get('metrics') async metricsText(@Res() response: Response) {
    response.type('text/plain');
    return response.send(await this.metrics.text());
  }
}
