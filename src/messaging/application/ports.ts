import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxBacklog {
  pending: number;
  oldestOccurredAt: Date | undefined;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /** Reserva até `limit` mensagens vencidas e sem lease válido (`SKIP LOCKED`), em ordem de inserção. */
  claimDue(now: Date, leaseUntil: Date, limit: number): Promise<OutboxMessage[]>;
  /** Idempotente: outra instância pode ter publicado depois que o lease expirou. */
  markPublished(ids: readonly string[], at: Date): Promise<void>;
  /** Persiste `attempts`/`nextAttemptAt` já calculados no domínio e libera o lease. */
  saveRetry(message: OutboxMessage, lastError: string): Promise<void>;
  backlog(): Promise<OutboxBacklog>;
}

export interface PublishFailure {
  id: string;
  error: string;
}

/** Broker de eventos de integração; devolve as mensagens que não foram aceitas. */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishFailure[]>;
}

export interface InboxRepository {
  /** `false` quando `(consumerName, messageId)` já existe. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}
