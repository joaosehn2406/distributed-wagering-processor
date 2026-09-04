export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  transportMessageId?: string;
  receivedAt: Date;
  processedAt?: Date;
}

/** Persistent delivery identity; the database primary key remains the arbiter. */
export class InboxMessage {
  private constructor(private state: InboxMessageState) {}

  static receive(input: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    return new InboxMessage({ ...input });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt;
  }

  get snapshot(): Readonly<InboxMessageState> {
    return this.state;
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (!this.state.processedAt) this.state.processedAt = at;
  }
}
