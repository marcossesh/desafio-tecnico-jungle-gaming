import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/money/money';
import type { LedgerPage, LedgerRepository, LedgerSummary } from '../../application/ports';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerEntrySchema, ledgerEntryToDomain, ledgerEntryToRecord } from './ledger-entry.record';

// Somas em centavos (bigint) para não depender de parsing de decimal com sinal.
const SUMMARY_SQL = `
  WITH chain AS (
    SELECT direction, amount, balance_before, wallet_version,
           lag(balance_after) OVER w AS previous_after,
           lag(wallet_version) OVER w AS previous_version
      FROM wallet_ledger_entries
     WHERE wallet_id = ?
    WINDOW w AS (ORDER BY wallet_version)
  )
  SELECT count(*)::int AS checked_entries,
         (COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) * 100)::bigint::text
           AS calculated_minor,
         count(*) FILTER (
           WHERE balance_before <> COALESCE(previous_after, 0)
              OR wallet_version <> COALESCE(previous_version + 1, wallet_version)
              OR (previous_version IS NULL AND wallet_version > 2)
         )::int AS chain_breaks,
         max(wallet_version) AS last_version,
         (SELECT (balance_after * 100)::bigint::text FROM wallet_ledger_entries
           WHERE wallet_id = ? ORDER BY wallet_version DESC LIMIT 1) AS last_after_minor
    FROM chain
`;

interface SummaryRow {
  checked_entries: number;
  calculated_minor: string;
  chain_breaks: number;
  last_version: number | null;
  last_after_minor: string | null;
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
  }

  async listByWallet(
    walletId: string,
    page: { beforeVersion?: number | undefined; limit: number },
  ): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntrySchema,
      page.beforeVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $lt: page.beforeVersion } },
      { orderBy: { walletVersion: 'desc' }, limit: page.limit + 1, disableIdentityMap: true },
    );
    return {
      entries: records.slice(0, page.limit).map(ledgerEntryToDomain),
      hasMore: records.length > page.limit,
    };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<SummaryRow[]>(SUMMARY_SQL, [walletId, walletId]);
    if (!row) throw new Error('Ledger summary returned no row');
    return {
      checkedEntries: row.checked_entries,
      calculatedBalance: Money.ofMinor(BigInt(row.calculated_minor), currency),
      lastBalanceAfter:
        row.last_after_minor === null ? undefined : Money.ofMinor(BigInt(row.last_after_minor), currency),
      lastVersion: row.last_version ?? undefined,
      chainBreaks: row.chain_breaks,
    };
  }
}
