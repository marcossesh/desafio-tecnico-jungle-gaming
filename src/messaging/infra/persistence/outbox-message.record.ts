import { EntitySchema } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../../domain/outbox-message';

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

// `seq`, `locked_until` e `last_error` ficam com o default do banco; o publisher (fase 7) os usa.
export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    partitionKey: { type: 'string' },
    eventType: { type: 'string' },
    eventVersion: { type: 'integer' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime' },
    publishedAt: { type: 'datetime', nullable: true },
  },
});

export function outboxMessageToRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    partitionKey: message.partitionKey,
    eventType: message.eventType,
    eventVersion: message.eventVersion,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt ?? null,
  };
}
