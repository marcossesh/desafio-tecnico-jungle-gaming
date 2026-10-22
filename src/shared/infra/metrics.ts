import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Metrics } from '../application/metrics';

export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly reconciliationDivergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Wallets whose stored balance diverged from the ledger',
    registers: [this.registry],
  });

  private readonly outboxDelay = new Histogram({
    name: 'outbox_publish_delay_seconds',
    help: 'Time between the financial commit and the event publication',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });

  private readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox messages whose publication failed and were rescheduled',
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }

  outboxPublished(publishDelaysSeconds: readonly number[]): void {
    for (const delay of publishDelaysSeconds) this.outboxDelay.observe(delay);
  }

  outboxPublishFailed(count: number): void {
    this.outboxFailures.inc(count);
  }

  outboxBacklog(pending: number, lagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(lagSeconds);
  }
}
