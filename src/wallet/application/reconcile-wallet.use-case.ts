import { Injectable } from '@nestjs/common';
import { Money } from '../../shared/domain/money.js';
import { DatabaseService } from '../../shared/infrastructure/database.service.js';
import { WagerRepository } from '../../wagering/infrastructure/wager.repository.js';
import { NotFoundError } from '../../wagering/application/submit-wager-transaction.use-case.js';

@Injectable()
export class ReconcileWalletUseCase {
  constructor(private readonly database: DatabaseService) {}
  async execute(walletId: string): Promise<{
    walletId: string;
    consistent: boolean;
    materializedBalance: string;
    ledgerBalance: string;
  }> {
    return this.database.transaction(async (em) => {
      const wallet = await WagerRepository.lockWallet(em, walletId);
      if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND');
      const data = await em
        .getConnection()
        .execute<
          { balance: string }[]
        >("SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0)::text AS balance FROM wallet_ledger_entries WHERE wallet_id=?", [walletId]);
      const ledger = Money.fromPersistence({
        amount: String(data[0]?.balance ?? '0.00'),
        currency: wallet.currency,
      });
      return {
        walletId,
        consistent: wallet.balance.equals(ledger),
        materializedBalance: wallet.balance.toString(),
        ledgerBalance: ledger.toString(),
      };
    });
  }
}
