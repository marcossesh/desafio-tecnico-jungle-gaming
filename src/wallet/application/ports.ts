import type { Money } from '../../shared/money/money';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** `SELECT … FOR UPDATE`: serializa operações da mesma wallet entre instâncias. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Lança ConcurrencyConflictError se a versão persistida não for `expectedVersion`. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  hasMore: boolean;
}

export interface LedgerSummary {
  checkedEntries: number;
  calculatedBalance: Money;
  lastBalanceAfter: Money | undefined;
  lastVersion: number | undefined;
  chainBreaks: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Ordem `wallet_version DESC`; `beforeVersion` exclusivo. */
  listByWallet(
    walletId: string,
    page: { beforeVersion?: number | undefined; limit: number },
  ): Promise<LedgerPage>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
