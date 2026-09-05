import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { DomainError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { businessFieldsOf, payloadHash } from '../../shared/application/canonical-hash.js';
import { DatabaseService } from '../../shared/infrastructure/database.service.js';
import {
  addMilliseconds,
  exponentialBackoffMilliseconds,
} from '../../shared/application/backoff.js';
import { loadEnvironment } from '../../config/environment.js';
import { businessMetrics } from '../../shared/infrastructure/metrics.service.js';
import { writeJsonLog } from '../../shared/infrastructure/structured-logger.js';
import type { Wallet } from '../../wallet/domain/wallet.js';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import { WagerTransaction, type WagerInput, type WagerKind } from '../domain/wager-transaction.js';
import { WagerRepository } from '../infrastructure/wager.repository.js';
import {
  WalletBalanceChangedEvent,
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
} from '../domain/events/wager-events.js';
import type { InboxClaim, SubmitCommand, SubmitResult } from './contracts.js';

const isReversal = (kind: WagerKind): kind is 'REFUND' | 'ROLLBACK' =>
  kind === 'REFUND' || kind === 'ROLLBACK';
const uuid = () => randomUUID();

export class ConflictError extends DomainError {}
export class NotFoundError extends DomainError {}
export class InboxConflictError extends DomainError {}
export class InboxInProgressError extends Error {}

function resultOf(transaction: WagerTransaction, replay: boolean): SubmitResult {
  const s = transaction.snapshot;
  const balance = s.status === 'PENDING_REFERENCE' ? s.acceptedBalance : s.resultBalance;
  const version = s.status === 'PENDING_REFERENCE' ? s.acceptedVersion : s.resultVersion;
  if (!balance || version === undefined) throw new DomainError('INVALID_TRANSACTION_STATE');
  return {
    transactionId: s.id,
    status: s.status,
    balance,
    walletVersion: version.toString(),
    failureCode: s.failureCode,
    idempotentReplay: replay,
  };
}

@Injectable()
export class SubmitWagerTransactionUseCase {
  private readonly env = loadEnvironment();

  constructor(private readonly database: DatabaseService) {}

  async submit(command: SubmitCommand, inbox?: InboxClaim): Promise<SubmitResult | undefined> {
    const startedAt = Date.now();
    const money = Money.fromContract(command.money);
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(command.kind))
      throw new DomainError('INVALID_TRANSACTION_KIND');
    const inputWithoutHash = {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? undefined,
    } as const;
    const hash = payloadHash(businessFieldsOf(inputWithoutHash));
    if (!inbox) {
      const fast = await this.database.em
        .fork()
        .transactional(async (em) => WagerRepository.findByIdempotency(em, command.idempotencyKey));
      if (fast) {
        const replay = this.replayOrConflict(fast, hash);
        this.recordResult(replay, command, undefined, startedAt);
        return replay;
      }
    }
    try {
      const result = await this.database.transaction(async (em) => {
        if (inbox) {
          const claimed = await WagerRepository.claimInbox(
            em,
            inbox.consumerName,
            inbox.messageId,
            inbox.payloadHash,
            inbox.transportMessageId,
          );
          if (claimed === 'CONFLICT') throw new InboxConflictError('INBOX_PAYLOAD_CONFLICT');
          if (claimed === 'DONE') return undefined;
          if (claimed === 'IN_PROGRESS') throw new InboxInProgressError('INBOX_IN_PROGRESS');
        }
        const wallet = await WagerRepository.lockWallet(em, command.walletId);
        if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND');
        const current = await WagerRepository.findByIdempotency(em, command.idempotencyKey);
        if (current) {
          const replay = this.replayOrConflict(current, hash);
          if (inbox) await WagerRepository.completeInbox(em, inbox.consumerName, inbox.messageId);
          return replay;
        }
        const external = await WagerRepository.findByProviderExternal(
          em,
          command.providerId,
          command.externalTransactionId,
        );
        if (external) throw new ConflictError('EXTERNAL_TRANSACTION_CONFLICT');
        if (wallet.playerId !== command.playerId) throw new DomainError('WALLET_PLAYER_MISMATCH');
        if (wallet.currency !== money.currency) throw new DomainError('CURRENCY_MISMATCH');
        const txInput: WagerInput = {
          ...inputWithoutHash,
          idempotencyKey: command.idempotencyKey,
          payloadHash: hash,
        };
        const transaction = WagerTransaction.create(txInput, uuid());
        // A ledger entry has a non-deferrable FK to this row. Establish the
        // auditable PENDING parent before resolving any balance movement.
        await WagerRepository.insertWager(em, transaction);
        const movement = await this.resolve(em, wallet, transaction);
        await WagerRepository.updateWager(em, transaction);
        await this.events(
          em,
          transaction,
          wallet,
          movement,
          command.correlationId ?? transaction.id,
          inbox?.messageId,
        );
        if (inbox) await WagerRepository.completeInbox(em, inbox.consumerName, inbox.messageId);
        return resultOf(transaction, false);
      });
      if (result) this.recordResult(result, command, inbox, startedAt);
      else if (inbox) {
        businessMetrics.recordDuplicate('inbox');
        writeJsonLog('info', 'wager.inbox_replay', {
          correlationId: command.correlationId,
          messageId: inbox.messageId,
          walletId: command.walletId,
          providerId: command.providerId,
          component: 'submit_wager',
        });
      }
      return result;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        businessMetrics.recordLockConflict();
        const resolved = await this.resolveUnique(
          command.idempotencyKey,
          command.providerId,
          command.externalTransactionId,
          hash,
        );
        this.recordResult(resolved, command, inbox, startedAt);
        return resolved;
      }
      throw error;
    }
  }
  async retryPending(transactionId: string): Promise<void> {
    let terminal: WagerTransaction | undefined;
    await this.database.transaction(async (em) => {
      const transaction = await WagerRepository.lockWager(em, transactionId);
      if (!transaction || transaction.status !== 'PENDING_REFERENCE') return;
      const wallet = await WagerRepository.lockWallet(em, transaction.snapshot.walletId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
      const state = transaction.snapshot;
      let movement: WalletLedgerEntry | undefined;
      if (state.referenceExpiresAt && state.referenceExpiresAt <= new Date())
        transaction.rejected('REFERENCE_NOT_FOUND', wallet.balance, wallet.version);
      else if (state.referenceAttempts >= this.env.pendingMaxAttempts)
        transaction.rejected('REFERENCE_NOT_FOUND', wallet.balance, wallet.version);
      else movement = await this.resolve(em, wallet, transaction);
      await WagerRepository.updateWager(em, transaction);
      if (transaction.status !== 'PENDING_REFERENCE') {
        await this.events(em, transaction, wallet, movement, transaction.id);
        terminal = transaction;
      }
    });
    if (terminal) {
      const state = terminal.snapshot;
      businessMetrics.recordTransaction(state.status);
      writeJsonLog('info', 'wager.pending_reference_terminal', {
        correlationId: terminal.id,
        transactionId: terminal.id,
        walletId: state.walletId,
        providerId: state.providerId,
        component: 'pending_reference',
        status: state.status,
        ...(state.failureCode === undefined ? {} : { code: state.failureCode }),
      });
    }
  }

  private async resolve(
    em: EntityManager,
    wallet: Wallet,
    transaction: WagerTransaction,
  ): Promise<WalletLedgerEntry | undefined> {
    const s = transaction.snapshot;
    try {
      let reference: WagerTransaction | undefined;
      if (s.referenceExternalTransactionId)
        reference = await WagerRepository.findByProviderExternal(
          em,
          s.providerId,
          s.referenceExternalTransactionId,
        );
      if (isReversal(s.kind) && !reference) {
        this.markPendingReference(transaction, wallet);
        return undefined;
      }
      if (reference) {
        this.assertReference(transaction, reference);
        if (
          isReversal(s.kind) &&
          (await WagerRepository.findProcessedReversal(em, reference.id, s.kind))
        )
          throw new DomainError('REFERENCE_ALREADY_REVERSED');
      }
      if (s.kind === 'BET') return await this.move(em, wallet, transaction, 'DEBIT');
      if (s.kind === 'WIN') return await this.move(em, wallet, transaction, 'CREDIT');
      if (s.kind === 'LOSS') {
        transaction.processed(wallet.balance, wallet.version, reference?.id);
        return undefined;
      }
      if (s.kind === 'REFUND')
        return await this.move(em, wallet, transaction, 'CREDIT', reference?.id);
      if (s.kind === 'ROLLBACK') {
        const refKind = reference?.snapshot.kind;
        if (refKind === 'BET')
          return await this.move(em, wallet, transaction, 'CREDIT', reference?.id);
        else if (refKind === 'WIN' || refKind === 'REFUND') {
          try {
            return await this.move(em, wallet, transaction, 'DEBIT', reference!.id);
          } catch (error) {
            if (error instanceof DomainError && error.code === 'INSUFFICIENT_FUNDS')
              throw new DomainError('ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE');
            throw error;
          }
        } else throw new DomainError('REFERENCE_KIND_NOT_ALLOWED');
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      transaction.rejected(error.code, wallet.balance, wallet.version);
      return undefined;
    }
    throw new DomainError('INVALID_TRANSACTION_KIND');
  }

  private async move(
    em: EntityManager,
    wallet: Wallet,
    transaction: WagerTransaction,
    direction: 'CREDIT' | 'DEBIT',
    referenceId?: string,
  ): Promise<WalletLedgerEntry> {
    const movement =
      direction === 'CREDIT'
        ? wallet.credit(transaction.snapshot.money)
        : wallet.debit(transaction.snapshot.money);
    transaction.processed(wallet.balance, wallet.version, referenceId);
    const entry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: movement.direction,
      money: movement.amount,
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
    });
    await WagerRepository.updateWallet(em, wallet);
    await WagerRepository.insertLedger(em, entry);
    return entry;
  }

  private assertReference(transaction: WagerTransaction, reference: WagerTransaction): void {
    const a = transaction.snapshot;
    const b = reference.snapshot;
    if (b.status !== 'PROCESSED') throw new DomainError('REFERENCE_NOT_PROCESSED');
    if (
      a.providerId !== b.providerId ||
      a.playerId !== b.playerId ||
      a.walletId !== b.walletId ||
      a.roundId !== b.roundId ||
      a.money.currency !== b.money.currency
    )
      throw new DomainError('REFERENCE_CONTEXT_MISMATCH');
    if (!a.money.equals(b.money)) throw new DomainError('REFERENCE_AMOUNT_MISMATCH');
    if (a.kind === 'REFUND' && b.kind !== 'BET')
      throw new DomainError('REFERENCE_KIND_NOT_ALLOWED');
    if (a.kind === 'WIN' && b.kind !== 'BET') throw new DomainError('REFERENCE_KIND_NOT_ALLOWED');
    if (a.kind === 'ROLLBACK' && !['BET', 'WIN', 'REFUND'].includes(b.kind))
      throw new DomainError('REFERENCE_KIND_NOT_ALLOWED');
  }
  private replayOrConflict(existing: WagerTransaction, hash: string): SubmitResult {
    if (existing.snapshot.payloadHash !== hash) throw new ConflictError('IDEMPOTENCY_CONFLICT');
    return resultOf(existing, true);
  }
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
  private async resolveUnique(
    idempotencyKey: string,
    providerId: string,
    externalId: string,
    hash: string,
  ): Promise<SubmitResult> {
    const winner = await this.database.em
      .fork()
      .transactional(
        async (em) =>
          (await WagerRepository.findByIdempotency(em, idempotencyKey)) ??
          (await WagerRepository.findByProviderExternal(em, providerId, externalId)),
      );
    if (!winner) throw new DomainError('TRANSIENT_UNIQUE_RACE');
    return winner.snapshot.idempotencyKey === idempotencyKey
      ? this.replayOrConflict(winner, hash)
      : (() => {
          throw new ConflictError('EXTERNAL_TRANSACTION_CONFLICT');
        })();
  }
  private markPendingReference(transaction: WagerTransaction, wallet: Wallet): void {
    const state = transaction.snapshot;
    const now = new Date();
    const expiresAt =
      state.referenceExpiresAt ?? addMilliseconds(now, this.env.pendingTtlSeconds * 1_000n);
    if (now >= expiresAt || state.referenceAttempts >= this.env.pendingMaxAttempts) {
      transaction.rejected('REFERENCE_NOT_FOUND', wallet.balance, wallet.version, now);
      return;
    }
    const retryAt = addMilliseconds(
      now,
      exponentialBackoffMilliseconds(
        state.referenceAttempts + 1n,
        this.env.pendingBackoffBaseSeconds,
        this.env.pendingBackoffMaxSeconds,
      ),
    );
    transaction.pendingReference(wallet.balance, wallet.version, retryAt, expiresAt, now);
  }
  private recordResult(
    result: SubmitResult,
    command: SubmitCommand,
    inbox: InboxClaim | undefined,
    startedAt: number,
  ): void {
    if (result.idempotentReplay) businessMetrics.recordDuplicate('idempotency');
    else businessMetrics.recordTransaction(result.status);
    businessMetrics.observeProcessingLatency(
      inbox === undefined ? 'http' : 'sqs_consumer',
      (Date.now() - startedAt) / 1_000,
    );
    writeJsonLog('info', 'wager.submitted', {
      correlationId: command.correlationId ?? result.transactionId,
      ...(inbox === undefined ? {} : { messageId: inbox.messageId }),
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      component: inbox === undefined ? 'http' : 'sqs_consumer',
      status: result.status,
      ...(result.failureCode === undefined ? {} : { code: result.failureCode }),
    });
  }
  private async events(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    movement: WalletLedgerEntry | undefined,
    correlationId: string,
    causationId?: string,
  ): Promise<void> {
    const s = tx.snapshot;
    const context = { correlationId, causationId, occurredAt: new Date() };
    if (s.status === 'PROCESSED')
      await WagerRepository.enqueueOutbox(em, WagerTransactionProcessedEvent.from(tx, context));
    else if (s.status === 'PENDING_REFERENCE')
      await WagerRepository.enqueueOutbox(
        em,
        WagerTransactionPendingReferenceEvent.from(tx, context),
      );
    else await WagerRepository.enqueueOutbox(em, WagerTransactionRejectedEvent.from(tx, context));
    if (movement)
      await WagerRepository.enqueueOutbox(
        em,
        WalletBalanceChangedEvent.from(wallet, tx, movement, context),
      );
  }
}
