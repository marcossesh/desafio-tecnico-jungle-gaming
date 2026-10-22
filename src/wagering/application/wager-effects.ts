import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { TransactionScope } from '../../shared/application/unit-of-work';
import type { Wallet } from '../../wallet/domain/wallet';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import type { WagerOutcome } from '../domain/wager-applier';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-kind';

export interface WagerEffects {
  /** Já gravada (INSERT ou UPDATE) pelo chamador. */
  transaction: WagerTransaction;
  wallet: Wallet;
  expectedVersion: number;
  outcome: WagerOutcome;
  eventContext: () => EventContext;
}

/** Lançamento + saldo + eventos + wake-up dos dependentes, na transação do chamador. */
export async function recordWagerEffects(scope: TransactionScope, effects: WagerEffects): Promise<void> {
  const { transaction, wallet, outcome } = effects;
  if (outcome.status === WagerTransactionStatus.Processed && outcome.entry) {
    await scope.ledger.insert(outcome.entry);
    await scope.wallets.saveBalance(wallet, effects.expectedVersion);
  }
  await scope.outbox.add(eventsFor(effects).map((event) => OutboxMessage.enqueue(event)));
  if (outcome.status === WagerTransactionStatus.Processed) {
    await scope.transactions.wakeDependents(
      transaction.walletId,
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.processedAt ?? new Date(),
    );
  }
}

function eventsFor({
  transaction,
  wallet,
  outcome,
  eventContext,
}: WagerEffects): IntegrationEvent<unknown>[] {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return outcome.entry
        ? [
            WagerTransactionProcessed.from(transaction, eventContext()),
            WalletBalanceChanged.from(wallet, outcome.entry, eventContext()),
          ]
        : [WagerTransactionProcessed.from(transaction, eventContext())];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, eventContext())];
    case WagerTransactionStatus.PendingReference:
      // só a entrada no estado gera evento; novas tentativas sem sucesso não
      return transaction.referenceAttempts === 0
        ? [WagerTransactionPendingReference.from(transaction, eventContext())]
        : [];
  }
}
