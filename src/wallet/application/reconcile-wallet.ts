import type { Logger } from 'pino';
import type { Metrics } from '../../shared/application/metrics';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { Money } from '../../shared/money/money';
import { requireWallet } from './wallet-queries';

export type ReconciliationIssue =
  | 'BALANCE_MISMATCH'
  | 'LAST_ENTRY_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'LEDGER_CHAIN_BROKEN';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  issues: ReconciliationIssue[];
}

export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  /** Só relata: divergência nunca é corrigida automaticamente. */
  async execute(walletId: string): Promise<ReconciliationReport> {
    // Snapshot único: saldo e ledger lidos no mesmo instante lógico.
    const { wallet, summary } = await this.uow.run(
      async ({ wallets, ledger }) => {
        const wallet = await requireWallet(wallets, walletId);
        return { wallet, summary: await ledger.summarize(wallet.id, wallet.currency) };
      },
      { isolation: 'repeatable read', readOnly: true },
    );

    const stored = wallet.balance;
    const issues: ReconciliationIssue[] = [];
    if (!summary.calculatedBalance.equals(stored)) issues.push('BALANCE_MISMATCH');
    if (!(summary.lastBalanceAfter ?? Money.zero(wallet.currency)).equals(stored)) {
      issues.push('LAST_ENTRY_MISMATCH');
    }
    // Wallet aberta sem saldo fica na versão 1 sem lançamentos.
    if ((summary.lastVersion ?? 1) !== wallet.version) issues.push('VERSION_MISMATCH');
    if (summary.chainBreaks > 0) issues.push('LEDGER_CHAIN_BROKEN');

    if (issues.length > 0) {
      this.metrics.reconciliationDivergence();
      this.logger.error(
        { walletId, issues, checkedEntries: summary.checkedEntries },
        'ledger divergence detected',
      );
    }

    return {
      walletId: wallet.id,
      storedBalance: stored,
      calculatedBalance: summary.calculatedBalance,
      difference: stored.subtract(summary.calculatedBalance),
      consistent: issues.length === 0,
      checkedEntries: summary.checkedEntries,
      issues,
    };
  }
}
