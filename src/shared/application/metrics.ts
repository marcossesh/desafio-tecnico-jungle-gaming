import type { TransientReason } from './errors';

export type Channel = 'http' | 'sqs' | 'worker';
export type ProcessingOutcome = 'new' | 'replay' | 'duplicate' | 'error';
export type SqsOutcome = 'ack' | 'retry' | 'dlq';

/** Eventos observáveis do negócio; a implementação decide nomes e labels (ARCHITECTURE §15). */
export interface Metrics {
  wagerTransaction(labels: { kind: string; status: string; channel: Channel }): void;
  wagerProcessingDuration(
    labels: { kind: string; channel: Channel; outcome: ProcessingOutcome },
    seconds: number,
  ): void;
  idempotentReplay(channel: Channel): void;
  idempotencyConflict(code: string): void;
  inboxDuplicate(consumer: string): void;
  lockConflict(reason: TransientReason): void;
  processingRetry(component: string, reason: string): void;
  sqsMessage(outcome: SqsOutcome): void;
  sqsDeadLettered(reason: string): void;
  sqsDlqDepth(depth: number): void;
  pendingReferences(count: number): void;
  reconciliationDivergence(): void;
  outboxPublished(publishDelaysSeconds: readonly number[]): void;
  outboxPublishFailed(count: number): void;
  outboxBacklog(pending: number, lagSeconds: number): void;
}
