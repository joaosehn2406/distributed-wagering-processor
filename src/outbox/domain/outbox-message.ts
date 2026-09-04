import type { IntegrationEvent, IntegrationEventEnvelope } from './integration-event.js';

export interface OutboxMessageState {
  id: string;
  eventId: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: IntegrationEventEnvelope<object>;
  attempts: bigint;
  nextAttemptAt: Date;
  publishedAt?: Date;
  leaseToken?: string;
  leaseUntil?: Date;
  leasedBy?: string;
  lastErrorCode?: string;
  createdAt: Date;
}

/** Persistent publication state. Network delivery is deliberately outside it. */
export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {}

  static enqueue<T extends object>(event: IntegrationEvent<T>): OutboxMessage {
    const payload: IntegrationEventEnvelope<object> = event.toJSON();
    return new OutboxMessage({
      id: event.eventId,
      eventId: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      eventVersion: event.version,
      payload,
      attempts: 0n,
      nextAttemptAt: event.occurredAt,
      createdAt: event.occurredAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state, payload: { ...state.payload } });
  }

  get snapshot(): Readonly<OutboxMessageState> {
    return this.state;
  }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt <= now;
  }

  markPublished(at: Date): void {
    this.state.publishedAt = at;
    this.state.leaseToken = undefined;
    this.state.leaseUntil = undefined;
    this.state.leasedBy = undefined;
    this.state.lastErrorCode = undefined;
  }

  scheduleRetry(nextAttemptAt: Date, errorCode: string): void {
    this.state.attempts += 1n;
    this.state.nextAttemptAt = nextAttemptAt;
    this.state.leaseToken = undefined;
    this.state.leaseUntil = undefined;
    this.state.leasedBy = undefined;
    this.state.lastErrorCode = errorCode;
  }
}
