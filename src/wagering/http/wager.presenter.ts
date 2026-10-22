import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-kind';

const HTTP_STATUS: Readonly<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 422,
};

/** Replay devolve o mesmo status HTTP porque é derivado só da linha persistida. */
export function httpStatusOf(transaction: WagerTransaction): number {
  return HTTP_STATUS[transaction.status];
}

export function presentResult(transaction: WagerTransaction, idempotentReplay: boolean) {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.resultBalance?.toJSON() ?? null,
    idempotentReplay,
  };
}

export function presentTransaction(transaction: WagerTransaction) {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.resultBalance?.toJSON() ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceCheckAt: transaction.nextReferenceCheckAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
