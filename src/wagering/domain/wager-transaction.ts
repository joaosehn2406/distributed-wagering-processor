import { DomainError } from '../../shared/domain/domain-error.js';
import { Money, type MoneyProps } from '../../shared/domain/money.js';

export const WagerKinds = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof WagerKinds)[number];
export const WagerStatuses = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;
export type WagerStatus = (typeof WagerStatuses)[number];
export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
}
export interface WagerState extends WagerInput {
  id: string;
  status: WagerStatus;
  referenceTransactionId?: string;
  failureCode?: string;
  acceptedBalance?: MoneyProps;
  acceptedVersion?: bigint;
  resultBalance?: MoneyProps;
  resultVersion?: bigint;
  referenceAttempts: bigint;
  nextReferenceAttemptAt?: Date;
  referenceExpiresAt?: Date;
  processedAt?: Date;
  terminalAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class WagerTransaction {
  private constructor(private state: WagerState) {}
  static create(input: WagerInput, id: string, now = new Date()): WagerTransaction {
    if (input.kind === 'OPENING') throw new DomainError('OPENING_NOT_EXTERNAL');
    if (!input.money.isPositive()) throw new DomainError('AMOUNT_MUST_BE_POSITIVE');
    if (
      (input.kind === 'REFUND' || input.kind === 'ROLLBACK') &&
      !input.referenceExternalTransactionId
    )
      throw new DomainError('REFERENCE_REQUIRED');
    return new WagerTransaction({
      ...input,
      id,
      status: 'PENDING',
      referenceAttempts: 0n,
      createdAt: now,
      updatedAt: now,
    });
  }
  static opening(
    input: Omit<WagerInput, 'kind'>,
    id: string,
    balance: Money,
    version: bigint,
    now = new Date(),
  ): WagerTransaction {
    return new WagerTransaction({
      ...input,
      id,
      kind: 'OPENING',
      status: 'PROCESSED',
      referenceAttempts: 0n,
      resultBalance: balance.toJSON(),
      resultVersion: version,
      processedAt: now,
      terminalAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  static rehydrate(state: WagerState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }
  get snapshot(): Readonly<WagerState> {
    return this.state;
  }
  get status(): WagerStatus {
    return this.state.status;
  }
  get id(): string {
    return this.state.id;
  }
  pendingReference(
    balance: Money,
    version: bigint,
    retryAt: Date,
    expiresAt: Date,
    now = new Date(),
  ): void {
    this.transition('PENDING_REFERENCE');
    Object.assign(this.state, {
      acceptedBalance: balance.toJSON(),
      acceptedVersion: version,
      referenceAttempts: this.state.referenceAttempts + 1n,
      nextReferenceAttemptAt: retryAt,
      referenceExpiresAt: expiresAt,
      updatedAt: now,
    });
  }
  processed(balance: Money, version: bigint, referenceId?: string, now = new Date()): void {
    this.transition('PROCESSED');
    Object.assign(this.state, {
      resultBalance: balance.toJSON(),
      resultVersion: version,
      referenceTransactionId: referenceId,
      processedAt: now,
      terminalAt: now,
      nextReferenceAttemptAt: undefined,
      updatedAt: now,
    });
  }
  rejected(code: string, balance: Money, version: bigint, now = new Date()): void {
    this.transition('REJECTED');
    Object.assign(this.state, {
      failureCode: code,
      resultBalance: balance.toJSON(),
      resultVersion: version,
      terminalAt: now,
      nextReferenceAttemptAt: undefined,
      updatedAt: now,
    });
  }
  failed(code: string, balance: Money, version: bigint, now = new Date()): void {
    this.transition('FAILED');
    Object.assign(this.state, {
      failureCode: code,
      resultBalance: balance.toJSON(),
      resultVersion: version,
      terminalAt: now,
      updatedAt: now,
    });
  }
  private transition(next: WagerStatus): void {
    const valid = this.state.status === 'PENDING' || this.state.status === 'PENDING_REFERENCE';
    if (!valid) throw new DomainError('INVALID_TRANSACTION_STATE');
    this.state.status = next;
  }
}
