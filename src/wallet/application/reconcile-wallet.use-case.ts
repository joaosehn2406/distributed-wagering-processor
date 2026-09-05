import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '../../shared/domain/money.js';
import { DatabaseService } from '../../shared/infrastructure/database.service.js';
import { writeJsonLog } from '../../shared/infrastructure/structured-logger.js';
import { businessMetrics } from '../../shared/infrastructure/metrics.service.js';
import { WagerRepository } from '../../wagering/infrastructure/wager.repository.js';
import { NotFoundError } from '../../wagering/application/submit-wager-transaction.use-case.js';

@Injectable()
export class ReconcileWalletUseCase {
  constructor(private readonly database: DatabaseService) {}
  async execute(
    walletId: string,
    correlationId?: string,
  ): Promise<{
    walletId: string;
    consistent: boolean;
    storedBalance: MoneyProps;
    calculatedBalance: MoneyProps;
    difference: MoneyProps;
    checkedEntries: string;
  }> {
    const result = await this.database.transaction(async (em) => {
      const wallet = await WagerRepository.lockWallet(em, walletId);
      if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND');
      const data = await em.execute<{ balance: string; checked_entries: string }[]>(
        "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0.00)::numeric(20,2)::text AS balance, count(*)::text AS checked_entries FROM wallet_ledger_entries WHERE wallet_id=?",
        [walletId],
      );
      const ledger = Money.fromPersistence({
        amount: String(data[0]?.balance ?? '0.00'),
        currency: wallet.currency,
      });
      return {
        walletId,
        consistent: wallet.balance.equals(ledger),
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: ledger.toJSON(),
        difference: wallet.balance.subtract(ledger).toJSON(),
        checkedEntries: String(data[0]?.checked_entries ?? '0'),
      };
    });
    writeJsonLog(result.consistent ? 'info' : 'error', 'wallet.reconciled', {
      correlationId,
      walletId,
      component: 'reconciliation',
      status: result.consistent ? 'CONSISTENT' : 'DIVERGENT',
    });
    if (!result.consistent) businessMetrics.recordReconciliationDivergence();
    return result;
  }
}
