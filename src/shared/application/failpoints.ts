/** Pontos de injeção de falha usados só por testes (env `FAILPOINTS`). */
export type FailpointName =
  | 'process.beforeCommit'
  | 'reprocess.beforeCommit'
  | 'consumer.afterCommitBeforeAck';

export interface Failpoints {
  hit(name: FailpointName): void;
}
