import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CreateWalletUseCase } from '../wallet/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../wallet/application/reconcile-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from '../wagering/application/submit-wager-transaction.use-case.js';
import { WagerRepository } from '../wagering/infrastructure/wager.repository.js';
import { DatabaseService } from '../shared/infrastructure/database.service.js';
import { HealthService } from '../health/health.service.js';
import { MetricsService } from '../shared/infrastructure/metrics.service.js';
import { DomainError } from '../shared/domain/domain-error.js';
import {
  CreateWalletDto,
  LedgerQueryDto,
  ProviderTransactionParamsDto,
  SubmitWagerDto,
  TransactionIdParamsDto,
  WalletIdParamsDto,
} from './http.dto.js';
import { correlationIdOf, type CorrelatedRequest } from './correlation.middleware.js';

function idempotencyKeyOf(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255)
    throw new DomainError('INVALID_PAYLOAD', 'Idempotency-Key is required');
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
  @Post('wallets')
  async createWallet(
    @Body() body: CreateWalletDto,
    @Req() request: CorrelatedRequest,
    @Res() response: Response,
  ) {
    const value = await this.wallets.execute({ ...body, correlationId: correlationIdOf(request) });
    return response.status(201).json(value);
  }
  @Get('wallets/:walletId')
  async wallet(@Param() params: WalletIdParamsDto) {
    const wallet = await WagerRepository.findWallet(this.database.em, params.walletId);
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version.toString(),
    };
  }
  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param() params: WalletIdParamsDto,
    @Query() query: LedgerQueryDto,
  ) {
    const limit = query.limit === undefined ? 50n : BigInt(query.limit);
    if (limit < 1n || limit > 100n) throw new DomainError('INVALID_PAYLOAD');
    let cursor: { createdAt: Date; id: string } | undefined;
    if (query.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
          createdAt: string;
          id: string;
        };
        if (!parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error('invalid');
        cursor = { id: parsed.id, createdAt: new Date(parsed.createdAt) };
      } catch {
        throw new DomainError('INVALID_PAYLOAD', 'invalid ledger cursor');
      }
    }
    const items = await WagerRepository.ledger(this.database.em, params.walletId, limit, cursor);
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
  @Post('wallets/:walletId/reconciliation')
  async reconciliation(@Param() params: WalletIdParamsDto, @Req() request: CorrelatedRequest) {
    return this.reconcile.execute(params.walletId, correlationIdOf(request));
  }
  @Post('wagering/transactions') async wager(
    @Body() body: SubmitWagerDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: CorrelatedRequest,
    @Res() response: Response,
  ) {
    const idempotencyKey = idempotencyKeyOf(key);
    const result = await this.submit.submit({
      ...body,
      idempotencyKey,
      correlationId: correlationIdOf(request),
    });
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
  @Get('wagering/transactions/:transactionId')
  async findTransaction(@Param() params: TransactionIdParamsDto) {
    return transactionJson(await WagerRepository.findById(this.database.em, params.transactionId));
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findExternal(@Param() params: ProviderTransactionParamsDto) {
    return transactionJson(
      await WagerRepository.findByProviderExternal(
        this.database.em,
        params.providerId,
        params.externalTransactionId,
      ),
    );
  }
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }
  @Get('health/ready') async ready() {
    return this.health.ready();
  }
  @Get('metrics') async metricsText(@Res() response: Response) {
    response.setHeader('Content-Type', this.metrics.contentType);
    return response.send(await this.metrics.text());
  }
}
