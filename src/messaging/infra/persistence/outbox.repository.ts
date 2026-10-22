import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageSchema, outboxMessageToRecord } from './outbox-message.record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageSchema, messages.map(outboxMessageToRecord));
  }
}
