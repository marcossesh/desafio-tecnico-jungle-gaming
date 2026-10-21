import { InvariantViolationError } from '../../shared/domain/errors';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { evaluateReference, type ReferenceContext } from './reference-policy';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionStatus } from './wager-transaction-kind';

export interface ApplyContext extends ReferenceContext {
  ledgerEntryId: string;
  at: Date;
  nextReferenceCheckAt: Date;
  /** Re-verificações após as quais vira REJECTED REFERENCE_NOT_FOUND. */
  maxReferenceAttempts: number;
}

export type WagerOutcome =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; code: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/** A wallet já vem travada; o chamador persiste tx, wallet e lançamento na mesma transação SQL. */
export function applyWager(tx: WagerTransaction, wallet: Wallet, ctx: ApplyContext): WagerOutcome {
  if (tx.walletId !== wallet.id) throw new InvariantViolationError('Transaction applied to another wallet');

  const reject = (code: FailureCode): WagerOutcome => {
    tx.reject(code, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, code };
  };

  if (tx.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  const decision = evaluateReference(tx, ctx);
  switch (decision.type) {
    case 'rejected':
      return reject(decision.code);
    case 'pending':
      return keepWaiting(tx, wallet, ctx);
    case 'none':
    case 'resolved':
      break;
  }
  const reference = decision.type === 'resolved' ? decision.reference : undefined;

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, wallet.balance, ctx.at);
    return { status: WagerTransactionStatus.Processed, entry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // operacionalmente diferentes: aposta sem saldo vs. reversão que deixaria saldo negativo
    return reject(tx.isReversal() ? FailureCode.InsufficientFundsForReversal : FailureCode.InsufficientFunds);
  }

  const entry =
    direction === LedgerDirection.Debit
      ? wallet.debit(tx.money, tx.id, ctx.ledgerEntryId, ctx.at)
      : wallet.credit(tx.money, tx.id, ctx.ledgerEntryId, ctx.at);
  tx.markProcessed(reference?.id, wallet.balance, ctx.at);
  return { status: WagerTransactionStatus.Processed, entry };
}

function keepWaiting(tx: WagerTransaction, wallet: Wallet, ctx: ApplyContext): WagerOutcome {
  if (tx.status === WagerTransactionStatus.Pending) {
    tx.markPendingReference(ctx.nextReferenceCheckAt, wallet.balance);
    return { status: WagerTransactionStatus.PendingReference };
  }
  if (tx.referenceAttempts + 1 >= ctx.maxReferenceAttempts) {
    tx.reject(FailureCode.ReferenceNotFound, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, code: FailureCode.ReferenceNotFound };
  }
  tx.recordReferenceMiss(ctx.nextReferenceCheckAt, wallet.balance);
  return { status: WagerTransactionStatus.PendingReference };
}
