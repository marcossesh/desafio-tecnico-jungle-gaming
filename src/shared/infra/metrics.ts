import { Counter, Registry } from 'prom-client';
import type { Metrics } from '../application/metrics';

export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly reconciliationDivergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Wallets whose stored balance diverged from the ledger',
    registers: [this.registry],
  });

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }
}
