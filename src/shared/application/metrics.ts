export interface Metrics {
  reconciliationDivergence(): void;
  outboxPublished(publishDelaysSeconds: readonly number[]): void;
  outboxPublishFailed(count: number): void;
  outboxBacklog(pending: number, lagSeconds: number): void;
}
