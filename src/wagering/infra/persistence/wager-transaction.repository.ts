import { type EntityManager, type FilterQuery, LockMode } from '@mikro-orm/postgresql';
import type { ClaimedTransaction, WagerTransactionRepository } from '../../application/ports';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction-kind';
import {
  type WagerTransactionRecord,
  WagerTransactionSchema,
  wagerTransactionMutableFields,
  wagerTransactionToDomain,
  wagerTransactionToRecord,
} from './wager-transaction.record';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, wagerTransactionToRecord(transaction));
  }

  async update(transaction: WagerTransaction, at: Date): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      { ...wagerTransactionMutableFields(transaction), updatedAt: at },
    );
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? wagerTransactionToDomain(record) : undefined;
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async claimDuePendingReferences(now: Date, leaseUntil: Date, limit: number): Promise<ClaimedTransaction[]> {
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `UPDATE wager_transactions SET next_reference_check_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= ?
           ORDER BY next_reference_check_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id, wallet_id`,
      [leaseUntil, now, now, limit],
    );
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }

  countPendingReferences(): Promise<number> {
    return this.em.count(WagerTransactionSchema, { status: WagerTransactionStatus.PendingReference });
  }

  wakeDependents(
    walletId: string,
    providerId: string,
    externalTransactionId: string,
    at: Date,
  ): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionSchema,
      {
        walletId,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
      },
      { nextReferenceCheckAt: at, updatedAt: at },
    );
  }

  private async findOne(where: FilterQuery<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, { disableIdentityMap: true });
    return record ? wagerTransactionToDomain(record) : undefined;
  }
}
