import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface InboxRepository {
  /** `false` quando `(consumerName, messageId)` já existe. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}
