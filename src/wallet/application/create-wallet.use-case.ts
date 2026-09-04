import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '../../shared/domain/money.js';
import { DatabaseService } from '../../shared/infrastructure/database.service.js';
import { Wallet, type BalanceMovement } from '../domain/wallet.js';
import { WagerTransaction } from '../../wagering/domain/wager-transaction.js';
import { WagerRepository } from '../../wagering/infrastructure/wager.repository.js';
import { ConflictError } from '../../wagering/application/submit-wager-transaction.use-case.js';
import { writeJsonLog } from '../../shared/infrastructure/structured-logger.js';
import { businessMetrics } from '../../shared/infrastructure/metrics.service.js';
import {
  WalletBalanceChangedEvent,
  WagerTransactionProcessedEvent,
} from '../../wagering/domain/events/wager-events.js';

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly database: DatabaseService) {}
  async execute(command: {
    playerId: string;
    initialBalance: MoneyProps;
    correlationId?: string;
  }): Promise<{ id: string; playerId: string; balance: MoneyProps; version: string }> {
    const money = Money.fromContract(command.initialBalance);
    const id = randomUUID();
    const now = new Date();
    try {
      const result = await this.database.transaction(async (em) => {
        const wallet = Wallet.open({ id, playerId: command.playerId, initialBalance: money, now });
        await WagerRepository.insertWallet(em, wallet);
        if (money.isPositive()) {
          const openingId = randomUUID();
          const opening = WagerTransaction.opening(
            {
              providerId: 'system',
              externalTransactionId: `opening:${id}`,
              idempotencyKey: `opening:${id}`,
              payloadHash: '0'.repeat(64),
              walletId: id,
              playerId: command.playerId,
              roundId: 'opening',
              gameId: 'opening',
              money,
            },
            openingId,
            wallet.balance,
            wallet.version,
            now,
          );
          // The parent row is persisted before the ledger row that references it.
          await WagerRepository.insertWager(em, opening);
          const movement: BalanceMovement = {
            direction: 'CREDIT',
            amount: money,
            balanceBefore: Money.zero(money.currency),
            balanceAfter: money,
          };
          await WagerRepository.insertLedger(em, id, openingId, movement);
          const context = { correlationId: command.correlationId ?? openingId, occurredAt: now };
          await WagerRepository.enqueueOutbox(
            em,
            WagerTransactionProcessedEvent.from(opening, context),
          );
          await WagerRepository.enqueueOutbox(
            em,
            WalletBalanceChangedEvent.from(wallet, opening, movement, context),
          );
        }
        return {
          id,
          playerId: command.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version.toString(),
        };
      });
      writeJsonLog('info', 'wallet.created', {
        correlationId: command.correlationId,
        walletId: result.id,
        component: 'wallet',
      });
      if (money.isPositive()) businessMetrics.recordTransaction('PROCESSED');
      return result;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      )
        throw new ConflictError('WALLET_ALREADY_EXISTS');
      throw error;
    }
  }
}
