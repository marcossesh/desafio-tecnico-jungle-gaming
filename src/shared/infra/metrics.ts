import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { TransientReason } from '../application/errors';
import type { Channel, Metrics, ProcessingOutcome, SqsOutcome } from '../application/metrics';

// Só métricas próprias: as default do prom-client dependem de APIs do Node que o Bun não expõe por completo.
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = this.counter(
    'wager_transactions_total',
    'Wager transactions by final status',
    ['kind', 'status', 'channel'],
  );
  private readonly duration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Wager processing latency, including retries',
    labelNames: ['kind', 'channel', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly replays = this.counter(
    'idempotent_replays_total',
    'Requests answered from the stored result',
    ['channel'],
  );
  private readonly conflicts = this.counter('idempotency_conflicts_total', 'Idempotency conflicts by code', [
    'code',
  ]);
  private readonly inboxDuplicates = this.counter(
    'inbox_duplicates_total',
    'Redelivered messages ignored by the inbox',
    ['consumer'],
  );
  private readonly lockConflicts = this.counter(
    'wallet_lock_conflicts_total',
    'Wallet lock/version conflicts',
    ['reason'],
  );
  private readonly retries = this.counter('processing_retries_total', 'Retries by component and reason', [
    'component',
    'reason',
  ]);
  private readonly sqsMessages = this.counter('sqs_messages_total', 'Consumed SQS messages by outcome', [
    'outcome',
  ]);
  private readonly deadLetters = this.counter(
    'sqs_dlq_messages_total',
    'Messages sent to the DLQ by reason',
    ['reason'],
  );
  private readonly dlqDepth = this.gauge('sqs_dlq_depth', 'Approximate number of messages in the DLQ');
  private readonly pending = this.gauge(
    'pending_reference_transactions',
    'Transactions waiting for their reference',
  );
  private readonly reconciliationDivergences = this.counter(
    'reconciliation_divergences_total',
    'Wallets whose stored balance diverged from the ledger',
  );
  private readonly outboxDelay = new Histogram({
    name: 'outbox_publish_delay_seconds',
    help: 'Time between the financial commit and the event publication',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });
  private readonly outboxFailures = this.counter(
    'outbox_publish_failures_total',
    'Outbox messages whose publication failed and were rescheduled',
  );
  private readonly outboxPending = this.gauge('outbox_pending_messages', 'Unpublished outbox messages');
  private readonly outboxLag = this.gauge(
    'outbox_lag_seconds',
    'Age of the oldest unpublished outbox message',
  );

  wagerTransaction(labels: { kind: string; status: string; channel: Channel }): void {
    this.transactions.inc(labels);
  }

  wagerProcessingDuration(
    labels: { kind: string; channel: Channel; outcome: ProcessingOutcome },
    seconds: number,
  ): void {
    this.duration.observe(labels, seconds);
  }

  idempotentReplay(channel: Channel): void {
    this.replays.inc({ channel });
  }

  idempotencyConflict(code: string): void {
    this.conflicts.inc({ code });
  }

  inboxDuplicate(consumer: string): void {
    this.inboxDuplicates.inc({ consumer });
  }

  lockConflict(reason: TransientReason): void {
    this.lockConflicts.inc({ reason });
  }

  processingRetry(component: string, reason: string): void {
    this.retries.inc({ component, reason });
  }

  sqsMessage(outcome: SqsOutcome): void {
    this.sqsMessages.inc({ outcome });
  }

  sqsDeadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  sqsDlqDepth(depth: number): void {
    this.dlqDepth.set(depth);
  }

  pendingReferences(count: number): void {
    this.pending.set(count);
  }

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

  private counter(name: string, help: string, labelNames: string[] = []): Counter {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }

  private gauge(name: string, help: string): Gauge {
    return new Gauge({ name, help, registers: [this.registry] });
  }
}
