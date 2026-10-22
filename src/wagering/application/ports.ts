import type { WagerTransaction } from '../domain/wager-transaction';

export interface ClaimedTransaction {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persiste apenas o estado mutável (status, resultado, agendamento de referência). */
  update(transaction: WagerTransaction, at: Date): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** `SELECT … FOR UPDATE`; chamar só com a wallet já travada (ordem de locks: wallet → transação). */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND/ROLLBACK `PROCESSED` apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Antecipa a re-verificação das transações que aguardam `externalTransactionId`. */
  /**
   * Reserva até `limit` pendentes vencidas (`SKIP LOCKED`) adiando a próxima checagem para `leaseUntil`:
   * outra instância não pega o mesmo item, e um crash no meio só atrasa o item até o lease expirar.
   */
  claimDuePendingReferences(now: Date, leaseUntil: Date, limit: number): Promise<ClaimedTransaction[]>;
  wakeDependents(
    walletId: string,
    providerId: string,
    externalTransactionId: string,
    at: Date,
  ): Promise<number>;
}
