/** Pontos de injeção de falha usados só por testes (env `FAILPOINTS`). */
export type FailpointName = 'process.beforeCommit' | 'reprocess.beforeCommit';

export interface Failpoints {
  hit(name: FailpointName): void;
}
