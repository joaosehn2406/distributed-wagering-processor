import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../shared/domain/money.js';
import { Wallet, type BalanceMovement } from '../../wallet/domain/wallet.js';
import {
  WagerTransaction,
  type WagerState,
  type WagerStatus,
} from '../domain/wager-transaction.js';
import type { LedgerItem } from '../application/contracts.js';

type Row = Record<string, unknown>;
const one = async (
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<Row | undefined> => (await em.getConnection().execute<Row[]>(sql, params))[0];
const rows = async (em: EntityManager, sql: string, params: unknown[] = []): Promise<Row[]> =>
  em.getConnection().execute<Row[]>(sql, params);
const asDate = (v: unknown): Date => new Date(String(v));
const optionalDate = (v: unknown): Date | undefined => (v == null ? undefined : asDate(v));
const optionalString = (v: unknown): string | undefined => (v == null ? undefined : String(v));

function walletOf(row: Row): Wallet {
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    currency: String(row.currency),
    balance: { amount: String(row.balance), currency: String(row.currency) },
    version: BigInt(String(row.version)),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  });
}
function wagerOf(row: Row): WagerTransaction {
  const currency = String(row.currency);
  const state: WagerState = {
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash),
    walletId: String(row.wallet_id),
    playerId: String(row.player_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: String(row.kind) as WagerState['kind'],
    money: Money.fromPersistence({ amount: String(row.amount), currency }),
    referenceExternalTransactionId: optionalString(row.reference_external_transaction_id),
    referenceTransactionId: optionalString(row.reference_transaction_id),
    status: String(row.status) as WagerStatus,
    failureCode: optionalString(row.failure_code),
    acceptedBalance:
      row.accepted_balance == null ? undefined : { amount: String(row.accepted_balance), currency },
    acceptedVersion:
      row.accepted_version == null ? undefined : BigInt(String(row.accepted_version)),
    resultBalance:
      row.result_balance == null ? undefined : { amount: String(row.result_balance), currency },
    resultVersion: row.result_version == null ? undefined : BigInt(String(row.result_version)),
    referenceAttempts: BigInt(String(row.reference_attempts)),
    nextReferenceAttemptAt: optionalDate(row.next_reference_attempt_at),
    referenceExpiresAt: optionalDate(row.reference_expires_at),
    processedAt: optionalDate(row.processed_at),
    terminalAt: optionalDate(row.terminal_at),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
  return WagerTransaction.rehydrate(state);
}

export class WagerRepository {
  static async lockWallet(em: EntityManager, id: string): Promise<Wallet | undefined> {
    const row = await one(em, 'SELECT * FROM wallets WHERE id = ? FOR UPDATE', [id]);
    return row ? walletOf(row) : undefined;
  }
  static async findWallet(em: EntityManager, id: string): Promise<Wallet | undefined> {
    const row = await one(em, 'SELECT * FROM wallets WHERE id = ?', [id]);
    return row ? walletOf(row) : undefined;
  }
  static async findByIdempotency(
    em: EntityManager,
    key: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await one(em, 'SELECT * FROM wager_transactions WHERE idempotency_key = ?', [key]);
    return row ? wagerOf(row) : undefined;
  }
  static async findById(em: EntityManager, id: string): Promise<WagerTransaction | undefined> {
    const row = await one(em, 'SELECT * FROM wager_transactions WHERE id = ?', [id]);
    return row ? wagerOf(row) : undefined;
  }
  static async findByProviderExternal(
    em: EntityManager,
    provider: string,
    external: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await one(
      em,
      'SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
      [provider, external],
    );
    return row ? wagerOf(row) : undefined;
  }
  static async lockWager(em: EntityManager, id: string): Promise<WagerTransaction | undefined> {
    const row = await one(em, 'SELECT * FROM wager_transactions WHERE id = ? FOR UPDATE', [id]);
    return row ? wagerOf(row) : undefined;
  }
  static async insertWallet(em: EntityManager, wallet: Wallet): Promise<void> {
    await em
      .getConnection()
      .execute(
        'INSERT INTO wallets(id,player_id,currency,balance,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version.toString(),
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );
  }
  static async updateWallet(em: EntityManager, wallet: Wallet): Promise<void> {
    await em
      .getConnection()
      .execute('UPDATE wallets SET balance=?, version=?, updated_at=? WHERE id=?', [
        wallet.balance.toString(),
        wallet.version.toString(),
        wallet.updatedAt,
        wallet.id,
      ]);
  }
  static async insertWager(em: EntityManager, tx: WagerTransaction): Promise<void> {
    const s = tx.snapshot;
    await em
      .getConnection()
      .execute(
        `INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_transaction_id,reference_transaction_id,status,failure_code,accepted_balance,accepted_version,result_balance,result_version,reference_attempts,next_reference_attempt_at,reference_expires_at,processed_at,terminal_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          s.id,
          s.providerId,
          s.externalTransactionId,
          s.idempotencyKey,
          s.payloadHash,
          s.walletId,
          s.playerId,
          s.roundId,
          s.gameId,
          s.kind,
          s.money.toString(),
          s.money.currency,
          s.referenceExternalTransactionId ?? null,
          s.referenceTransactionId ?? null,
          s.status,
          s.failureCode ?? null,
          s.acceptedBalance?.amount ?? null,
          s.acceptedVersion?.toString() ?? null,
          s.resultBalance?.amount ?? null,
          s.resultVersion?.toString() ?? null,
          s.referenceAttempts.toString(),
          s.nextReferenceAttemptAt ?? null,
          s.referenceExpiresAt ?? null,
          s.processedAt ?? null,
          s.terminalAt ?? null,
          s.createdAt,
          s.updatedAt,
        ],
      );
  }
  static async updateWager(em: EntityManager, tx: WagerTransaction): Promise<void> {
    const s = tx.snapshot;
    await em
      .getConnection()
      .execute(
        'UPDATE wager_transactions SET reference_transaction_id=?,status=?,failure_code=?,accepted_balance=?,accepted_version=?,result_balance=?,result_version=?,reference_attempts=?,next_reference_attempt_at=?,reference_expires_at=?,processed_at=?,terminal_at=?,updated_at=? WHERE id=?',
        [
          s.referenceTransactionId ?? null,
          s.status,
          s.failureCode ?? null,
          s.acceptedBalance?.amount ?? null,
          s.acceptedVersion?.toString() ?? null,
          s.resultBalance?.amount ?? null,
          s.resultVersion?.toString() ?? null,
          s.referenceAttempts.toString(),
          s.nextReferenceAttemptAt ?? null,
          s.referenceExpiresAt ?? null,
          s.processedAt ?? null,
          s.terminalAt ?? null,
          s.updatedAt,
          s.id,
        ],
      );
  }
  static async insertLedger(
    em: EntityManager,
    walletId: string,
    transactionId: string,
    movement: BalanceMovement,
  ): Promise<void> {
    await em
      .getConnection()
      .execute(
        'INSERT INTO wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          walletId,
          transactionId,
          movement.direction,
          movement.amount.toString(),
          movement.amount.currency,
          movement.balanceBefore.toString(),
          movement.balanceAfter.toString(),
          new Date(),
        ],
      );
  }
  static async ledger(
    em: EntityManager,
    walletId: string,
    limit: bigint,
    cursor?: { createdAt: Date; id: string },
  ): Promise<LedgerItem[]> {
    const params: unknown[] = [walletId];
    let where = 'WHERE wallet_id=?';
    if (cursor) {
      where += ' AND (created_at,id) > (?,?)';
      params.push(cursor.createdAt, cursor.id);
    }
    params.push(limit.toString());
    const result = await rows(
      em,
      `SELECT * FROM wallet_ledger_entries ${where} ORDER BY created_at,id LIMIT ?`,
      params,
    );
    return result.map((r) => ({
      id: String(r.id),
      transactionId: String(r.transaction_id),
      direction: String(r.direction) as LedgerItem['direction'],
      amount: { amount: String(r.amount), currency: String(r.currency) },
      balanceBefore: { amount: String(r.balance_before), currency: String(r.currency) },
      balanceAfter: { amount: String(r.balance_after), currency: String(r.currency) },
      createdAt: asDate(r.created_at),
    }));
  }
  static async pendingDue(em: EntityManager, limit: bigint): Promise<WagerTransaction[]> {
    const result = await rows(
      em,
      "SELECT * FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_reference_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT ?",
      [limit.toString()],
    );
    return result.map(wagerOf);
  }
  static async insertOutbox(
    em: EntityManager,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const id = randomUUID();
    await em
      .getConnection()
      .execute(
        'INSERT INTO outbox_messages(id,event_id,aggregate_id,event_type,event_version,payload,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,1,?,0,now(),now())',
        [
          id,
          id,
          aggregateId,
          eventType,
          JSON.stringify({ eventId: id, eventVersion: 1, aggregateId, ...payload }),
        ],
      );
  }
  static async claimInbox(
    em: EntityManager,
    consumer: string,
    messageId: string,
    hash: string,
    transportId?: string,
  ): Promise<'CLAIMED' | 'DONE' | 'CONFLICT'> {
    const inserted = await rows(
      em,
      'INSERT INTO inbox_messages(consumer_name,message_id,payload_hash,transport_message_id,received_at) VALUES (?,?,?,?,now()) ON CONFLICT DO NOTHING RETURNING message_id',
      [consumer, messageId, hash, transportId ?? null],
    );
    if (inserted.length) return 'CLAIMED';
    const record = await one(
      em,
      'SELECT payload_hash,processed_at FROM inbox_messages WHERE consumer_name=? AND message_id=?',
      [consumer, messageId],
    );
    if (!record || String(record.payload_hash) !== hash) return 'CONFLICT';
    return record.processed_at ? 'DONE' : 'CONFLICT';
  }
  static async completeInbox(
    em: EntityManager,
    consumer: string,
    messageId: string,
  ): Promise<void> {
    await em
      .getConnection()
      .execute(
        'UPDATE inbox_messages SET processed_at=now() WHERE consumer_name=? AND message_id=?',
        [consumer, messageId],
      );
  }
}
