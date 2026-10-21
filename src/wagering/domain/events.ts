import { type EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import type { MoneyProps } from '../../shared/money/money';
import type { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import type { WagerTransactionKind } from './wager-transaction-kind';

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function txProps<T>(tx: WagerTransaction, ctx: EventContext, data: T) {
  return { ...ctx, aggregateId: tx.id, partitionKey: tx.walletId, data };
}

export interface WagerTransactionProcessedData extends TransactionRef {
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      txProps(tx, ctx, {
        ...transactionRef(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balanceAfter: tx.resultBalance?.toJSON() ?? null,
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
  balance: MoneyProps | null;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error(`Transaction ${tx.id} has no failureCode`);
    return new WagerTransactionRejected(
      txProps(tx, ctx, {
        ...transactionRef(tx),
        failureCode: tx.failureCode,
        balance: tx.resultBalance?.toJSON() ?? null,
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      txProps(tx, ctx, {
        ...transactionRef(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
        attempts: tx.referenceAttempts,
        nextCheckAt: tx.nextReferenceCheckAt?.toISOString() ?? null,
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
