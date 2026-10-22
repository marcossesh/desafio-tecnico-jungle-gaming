import type { FailpointName, Failpoints } from '../application/failpoints';

export class FailpointError extends Error {
  constructor(readonly failpoint: FailpointName) {
    super(`failpoint ${failpoint}`);
    this.name = 'FailpointError';
  }
}

// Simulam a morte do processo (como um SIGKILL) em vez de uma exceção tratável.
const CRASH_FAILPOINTS: ReadonlySet<FailpointName> = new Set(['consumer.afterCommitBeforeAck']);

export function failpointsFrom(spec: string): Failpoints {
  const active = new Set(
    spec
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return {
    hit(name) {
      if (!active.has(name)) return;
      if (CRASH_FAILPOINTS.has(name)) process.exit(137);
      throw new FailpointError(name);
    },
  };
}
