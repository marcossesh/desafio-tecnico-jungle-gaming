import { EntitySchema } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/money/money';
import type { FailureCode } from '../../domain/failure-code';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction-kind';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  resultBalance: string | null;
  resultCurrency: string | null;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

const nullableText = { type: 'string', nullable: true } as const;
const nullableDate = { type: 'datetime', nullable: true } as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: nullableText,
    gameId: nullableText,
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: nullableText,
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: nullableText,
    resultBalance: { type: 'decimal', precision: 20, scale: 2, nullable: true },
    resultCurrency: { type: 'string', columnType: 'char(3)', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: nullableDate,
    correlationId: nullableText,
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
    processedAt: nullableDate,
  },
});

export function wagerTransactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId ?? undefined,
    gameId: record.gameId ?? undefined,
    kind: record.kind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    correlationId: record.correlationId ?? undefined,
    createdAt: record.createdAt,
    status: record.status,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: record.failureCode ?? undefined,
    processedAt: record.processedAt ?? undefined,
    resultBalance:
      record.resultBalance === null || record.resultCurrency === null
        ? undefined
        : Money.from({ amount: record.resultBalance, currency: record.resultCurrency }),
    referenceAttempts: record.referenceAttempts,
    nextReferenceCheckAt: record.nextReferenceCheckAt ?? undefined,
  });
}

/** Colunas que mudam após o INSERT; o resto é imutável (trigger `wager_transactions_guard`). */
export function wagerTransactionMutableFields(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultBalance: transaction.resultBalance?.amount ?? null,
    resultCurrency: transaction.resultBalance?.currency ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceCheckAt: transaction.nextReferenceCheckAt ?? null,
    processedAt: transaction.processedAt ?? null,
  };
}

export function wagerTransactionToRecord(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    correlationId: transaction.correlationId ?? null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.createdAt,
    ...wagerTransactionMutableFields(transaction),
  };
}
