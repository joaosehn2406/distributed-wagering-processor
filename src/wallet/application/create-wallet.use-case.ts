import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '../../shared/domain/money.js';
import { DatabaseService } from '../../shared/infrastructure/database.service.js';
import { Wallet } from '../domain/wallet.js';
import { WagerTransaction } from '../../wagering/domain/wager-transaction.js';
import { WagerRepository } from '../../wagering/infrastructure/wager.repository.js';
import { ConflictError } from '../../wagering/application/submit-wager-transaction.use-case.js';

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly database: DatabaseService) {}
  async execute(command: {
    playerId: string;
    initialBalance: MoneyProps;
  }): Promise<{ id: string; playerId: string; balance: MoneyProps; version: string }> {
    const money = Money.fromContract(command.initialBalance);
    const id = randomUUID();
    const now = new Date();
    try {
      return await this.database.transaction(async (em) => {
        const wallet = Wallet.open({ id, playerId: command.playerId, initialBalance: money, now });
        await WagerRepository.insertWallet(em, wallet);
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
        await WagerRepository.insertWager(em, opening);
        if (money.isPositive())
          await WagerRepository.insertLedger(em, id, openingId, {
            direction: 'CREDIT',
            amount: money,
            balanceBefore: Money.zero(money.currency),
            balanceAfter: money,
          });
        await WagerRepository.insertOutbox(em, id, 'WagerTransactionProcessed', {
          transactionId: openingId,
          status: 'PROCESSED',
          kind: 'OPENING',
          correlationId: openingId,
        });
        if (money.isPositive())
          await WagerRepository.insertOutbox(em, id, 'WalletBalanceChanged', {
            transactionId: openingId,
            walletVersion: '1',
            correlationId: openingId,
          });
        return {
          id,
          playerId: command.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version.toString(),
        };
      });
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
