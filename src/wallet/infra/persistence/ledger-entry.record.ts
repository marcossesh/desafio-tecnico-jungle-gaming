import { EntitySchema } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/money/money';
import type { LedgerDirection } from '../../domain/ledger-direction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    walletVersion: { type: 'integer' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    createdAt: { type: 'datetime' },
  },
});

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    walletVersion: record.walletVersion,
    direction: record.direction,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    createdAt: entry.createdAt,
  };
}
