import { addMs, type BackoffPolicy, exponentialBackoffMs } from '../../shared/domain/backoff';
import { InvariantViolationError } from '../../shared/domain/errors';
import type { IntegrationEvent } from './integration-event';

export const DEFAULT_OUTBOX_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 300_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly partitionKey: string,
    readonly eventType: string,
    readonly eventVersion: number,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
  ) {}

  /** `id` = eventId: consumidores deduplicam por ele. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.partitionKey,
      event.eventType,
      event.version,
      Object.freeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.partitionKey,
      state.eventType,
      state.eventVersion,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    this._publishedAt = at;
  }

  /** Sem limite de tentativas: evento confirmado nunca é descartado. */
  scheduleRetry(now: Date, policy: BackoffPolicy = DEFAULT_OUTBOX_BACKOFF): void {
    if (!this.isPending()) throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    this._attempts += 1;
    this._nextAttemptAt = addMs(now, exponentialBackoffMs(this._attempts, policy));
  }
}
