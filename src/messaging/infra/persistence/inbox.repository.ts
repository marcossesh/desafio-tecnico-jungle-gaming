import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import { InboxMessageSchema, inboxMessageToDomain, inboxMessageToRecord } from './inbox-message.record';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const record = inboxMessageToRecord(message);
    const rows = await this.em.execute<{ inserted: number }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING 1 AS inserted`,
      [record.consumerName, record.messageId, record.payloadHash, record.receivedAt, record.processedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxMessageSchema,
      { consumerName, messageId },
      { disableIdentityMap: true },
    );
    return record ? inboxMessageToDomain(record) : undefined;
  }
}
