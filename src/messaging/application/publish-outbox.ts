import type { Logger } from 'pino';
import type { Metrics } from '../../shared/application/metrics';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { addMs, type BackoffPolicy } from '../../shared/domain/backoff';
import type { Clock } from '../../shared/domain/ports';
import type { EventPublisher } from './ports';

export interface PublishOutboxSettings {
  batchSize: number;
  leaseMs: number;
  backoff: BackoffPolicy;
}

export interface PublishReport {
  claimed: number;
  published: number;
  failed: number;
}

/** Claim curto no banco, I/O com o broker fora de transação; o lease cobre a morte entre os dois. */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly settings: PublishOutboxSettings,
  ) {}

  /** Repete enquanto os lotes vierem cheios: sob carga, esperar o próximo tick por lote fazia o backlog crescer. */
  async drain(maxBatches = 20): Promise<PublishReport> {
    const total: PublishReport = { claimed: 0, published: 0, failed: 0 };
    for (let batch = 0; batch < maxBatches; batch++) {
      const report = await this.runOnce();
      total.claimed += report.claimed;
      total.published += report.published;
      total.failed += report.failed;
      if (report.claimed < this.settings.batchSize || report.failed > 0) break;
    }
    return total;
  }

  async runOnce(): Promise<PublishReport> {
    const now = this.clock.now();
    const claimed = await this.uow.run(({ outbox }) =>
      outbox.claimDue(now, addMs(now, this.settings.leaseMs), this.settings.batchSize),
    );

    let failures: { id: string; error: string }[] = [];
    if (claimed.length > 0) {
      try {
        failures = await this.publisher.publish(claimed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures = claimed.map(({ id }) => ({ id, error: message }));
      }
    }

    const at = this.clock.now();
    const errors = new Map(failures.map((f) => [f.id, f.error]));
    const published = claimed.filter((m) => !errors.has(m.id));
    const failed = claimed.filter((m) => errors.has(m.id));
    for (const message of failed) message.scheduleRetry(at, this.settings.backoff);

    const backlog = await this.uow.run(async ({ outbox }) => {
      await outbox.markPublished(
        published.map((m) => m.id),
        at,
      );
      for (const message of failed) await outbox.saveRetry(message, errors.get(message.id) ?? 'unknown');
      return outbox.backlog();
    });

    if (failed.length > 0) {
      this.metrics.outboxPublishFailed(failed.length);
      this.logger.warn({ failed: failed.length, error: failures[0]?.error }, 'outbox publish failed');
    }
    this.metrics.outboxPublished(published.map((m) => (at.getTime() - m.occurredAt.getTime()) / 1_000));
    const lagSeconds = backlog.oldestOccurredAt
      ? (at.getTime() - backlog.oldestOccurredAt.getTime()) / 1_000
      : 0;
    this.metrics.outboxBacklog(backlog.pending, Math.max(0, lagSeconds));

    return { claimed: claimed.length, published: published.length, failed: failed.length };
  }
}
