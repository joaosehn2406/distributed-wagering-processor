import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../shared/domain/money.js';
import { OutboxMessage } from '../../outbox/domain/outbox-message.js';
import type { IntegrationEvent } from '../../outbox/domain/integration-event.js';
import { InboxMessage } from '../../messaging/domain/inbox-message.js';
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
): Promise<Row | undefined> => (await em.execute<Row[]>(sql, params))[0];
const rows = async (em: EntityManager, sql: string, params: unknown[] = []): Promise<Row[]> =>
  em.execute<Row[]>(sql, params);
const asDate = (v: unknown): Date => new Date(String(v));
const optionalDate = (v: unknown): Date | undefined => (v == null ? undefined : asDate(v));
const optionalString = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const objectOf = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  const parsed: unknown = JSON.parse(String(v));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('invalid outbox payload');
  return parsed as Record<string, unknown>;
};

export interface ClaimedOutboxMessage {
  id: string;
  eventId: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  leaseToken: string;
  attempts: bigint;
}

export interface OutboxLag {
  pending: bigint;
  oldestCreatedAt?: Date;
}

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
    await em.execute(
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
    await em.execute('UPDATE wallets SET balance=?, version=?, updated_at=? WHERE id=?', [
      wallet.balance.toString(),
      wallet.version.toString(),
      wallet.updatedAt,
      wallet.id,
    ]);
  }
  static async insertWager(em: EntityManager, tx: WagerTransaction): Promise<void> {
    const s = tx.snapshot;
    await em.execute(
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
    await em.execute(
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
    await em.execute(
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
  static async enqueueOutbox(em: EntityManager, event: IntegrationEvent<object>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    const state = message.snapshot;
    await em.execute(
      'INSERT INTO outbox_messages(id,event_id,aggregate_id,event_type,event_version,payload,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,0,now(),now())',
      [
        state.id,
        state.eventId,
        state.aggregateId,
        state.eventType,
        state.eventVersion,
        JSON.stringify(state.payload),
      ],
    );
  }
  static async claimInbox(
    em: EntityManager,
    consumer: string,
    messageId: string,
    hash: string,
    transportId?: string,
  ): Promise<'CLAIMED' | 'DONE' | 'IN_PROGRESS' | 'CONFLICT'> {
    const inbox = InboxMessage.receive({
      consumerName: consumer,
      messageId,
      payloadHash: hash,
      transportMessageId: transportId,
      receivedAt: new Date(),
    });
    const state = inbox.snapshot;
    const inserted = await rows(
      em,
      'INSERT INTO inbox_messages(consumer_name,message_id,payload_hash,transport_message_id,received_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING message_id',
      [
        state.consumerName,
        state.messageId,
        state.payloadHash,
        state.transportMessageId ?? null,
        state.receivedAt,
      ],
    );
    if (inserted.length) return 'CLAIMED';
    const record = await one(
      em,
      'SELECT payload_hash,processed_at FROM inbox_messages WHERE consumer_name=? AND message_id=?',
      [consumer, messageId],
    );
    if (!record || String(record.payload_hash) !== hash) return 'CONFLICT';
    return record.processed_at ? 'DONE' : 'IN_PROGRESS';
  }
  static async completeInbox(
    em: EntityManager,
    consumer: string,
    messageId: string,
  ): Promise<void> {
    await em.execute(
      'UPDATE inbox_messages SET processed_at=now() WHERE consumer_name=? AND message_id=?',
      [consumer, messageId],
    );
  }
  static async claimDueOutbox(
    em: EntityManager,
    instanceId: string,
    leaseUntil: Date,
    limit: bigint,
  ): Promise<ClaimedOutboxMessage[]> {
    const candidates = await rows(
      em,
      'SELECT * FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ?',
      [limit.toString()],
    );
    const claimed: ClaimedOutboxMessage[] = [];
    for (const candidate of candidates) {
      const leaseToken = randomUUID();
      const updated = await rows(
        em,
        'UPDATE outbox_messages SET lease_token=?,lease_until=?,leased_by=?,attempts=attempts+1,last_error_code=NULL WHERE id=? AND published_at IS NULL RETURNING id,event_id,aggregate_id,payload,attempts',
        [leaseToken, leaseUntil, instanceId, candidate.id],
      );
      const row = updated[0];
      if (!row) continue;
      claimed.push({
        id: String(row.id),
        eventId: String(row.event_id),
        aggregateId: String(row.aggregate_id),
        payload: objectOf(row.payload),
        leaseToken,
        attempts: BigInt(String(row.attempts)),
      });
    }
    return claimed;
  }
  static async markOutboxPublished(
    em: EntityManager,
    id: string,
    leaseToken: string,
  ): Promise<boolean> {
    const updated = await rows(
      em,
      'UPDATE outbox_messages SET published_at=now(),lease_token=NULL,lease_until=NULL,leased_by=NULL,last_error_code=NULL WHERE id=? AND lease_token=? AND published_at IS NULL RETURNING id',
      [id, leaseToken],
    );
    return updated.length === 1;
  }
  static async scheduleOutboxRetry(
    em: EntityManager,
    id: string,
    leaseToken: string,
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const updated = await rows(
      em,
      'UPDATE outbox_messages SET lease_token=NULL,lease_until=NULL,leased_by=NULL,next_attempt_at=?,last_error_code=? WHERE id=? AND lease_token=? AND published_at IS NULL RETURNING id',
      [nextAttemptAt, errorCode, id, leaseToken],
    );
    return updated.length === 1;
  }
  static async outboxLag(em: EntityManager): Promise<OutboxLag> {
    const row = await one(
      em,
      'SELECT count(*)::text AS pending, min(created_at) AS oldest_created_at FROM outbox_messages WHERE published_at IS NULL',
    );
    return {
      pending: BigInt(String(row?.pending ?? '0')),
      oldestCreatedAt: row?.oldest_created_at ? asDate(row.oldest_created_at) : undefined,
    };
  }
  static async claimDuePending(
    em: EntityManager,
    leaseUntil: Date,
    limit: bigint,
  ): Promise<string[]> {
    const rows = await em.execute<{ id: string }[]>(
      "SELECT id FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_reference_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT ?",
      [limit.toString()],
    );
    const ids: string[] = [];
    for (const row of rows) {
      const updated = await em.execute<{ id: string }[]>(
        "UPDATE wager_transactions SET next_reference_attempt_at=?,updated_at=now() WHERE id=? AND status='PENDING_REFERENCE' RETURNING id",
        [leaseUntil, row.id],
      );
      if (updated.length) ids.push(String(updated[0]!.id));
    }
    return ids;
  }
}
