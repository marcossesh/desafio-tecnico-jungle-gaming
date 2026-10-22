import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxBacklog, OutboxRepository } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import {
  type OutboxMessageRecord,
  OutboxMessageSchema,
  outboxMessageToDomain,
  outboxMessageToRecord,
} from './outbox-message.record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageSchema, messages.map(outboxMessageToRecord));
  }

  async claimDue(now: Date, leaseUntil: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<(Record<string, unknown> & { seq: string })[]>(
      `UPDATE outbox_messages SET locked_until = ?
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY seq
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [leaseUntil, now, now, limit],
    );
    // RETURNING não garante ordem; a ordem por partição depende de `seq`
    rows.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    return rows.map((row) =>
      outboxMessageToDomain(this.em.map(OutboxMessageSchema, row) as OutboxMessageRecord),
    );
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: { $in: [...ids] }, publishedAt: null },
      { publishedAt: at, lockedUntil: null, lastError: null },
    );
  }

  async saveRetry(message: OutboxMessage, lastError: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt, lockedUntil: null, lastError },
    );
  }

  async backlog(): Promise<OutboxBacklog> {
    const [row] = await this.em.execute<{ pending: number; oldest: string | null }[]>(
      'SELECT count(*)::int AS pending, min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
    );
    return { pending: row?.pending ?? 0, oldestOccurredAt: row?.oldest ? new Date(row.oldest) : undefined };
  }
}
