import type { InboxRepository, OutboxRepository } from '../../messaging/application/ports';
import type { WagerTransactionRepository } from '../../wagering/application/ports';
import type { LedgerRepository, WalletRepository } from '../../wallet/application/ports';

export interface TransactionScope {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read';
  readOnly?: boolean;
  lockTimeoutMs?: number;
}

/** Uma transação SQL: tudo que `work` grava via `scope` é confirmado junto ou descartado junto. */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: TransactionOptions): Promise<T>;
}
