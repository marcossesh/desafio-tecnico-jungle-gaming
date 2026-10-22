import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persiste apenas o estado mutável (status, resultado, agendamento de referência). */
  update(transaction: WagerTransaction, at: Date): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
}
