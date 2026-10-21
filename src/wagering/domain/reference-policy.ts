import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import { ALLOWED_REFERENCE_KINDS, WagerTransactionStatus } from './wager-transaction-kind';

export type ReferenceDecision =
  | { type: 'none' }
  | { type: 'pending' }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'resolved'; reference: WagerTransaction };

export interface ReferenceContext {
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se ainda não chegou. */
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
}

/** Uma reversão por referência, de qualquer tipo: REFUND + ROLLBACK da mesma BET creditariam duas vezes. */
export function evaluateReference(tx: WagerTransaction, ctx: ReferenceContext): ReferenceDecision {
  if (!tx.referenceExternalTransactionId) return { type: 'none' };

  const { reference } = ctx;
  if (
    !reference ||
    reference.status === WagerTransactionStatus.Pending ||
    reference.status === WagerTransactionStatus.PendingReference
  ) {
    return { type: 'pending' };
  }

  const reject = (code: FailureCode): ReferenceDecision => ({ type: 'rejected', code });

  if (
    reference.providerId !== tx.providerId ||
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.money.currency !== tx.money.currency ||
    reference.roundId !== tx.roundId
  ) {
    return reject(FailureCode.ReferenceMismatch);
  }
  if (!ALLOWED_REFERENCE_KINDS[tx.kind].includes(reference.kind)) {
    return reject(FailureCode.ReferenceKindNotAllowed);
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(FailureCode.ReferenceNotProcessed);
  }
  if (tx.isReversal() && !tx.money.equals(reference.money)) {
    return reject(FailureCode.ReferenceAmountMismatch);
  }
  if (ctx.referenceAlreadyReversed) {
    return reject(FailureCode.ReferenceAlreadyReversed);
  }
  return { type: 'resolved', reference };
}
