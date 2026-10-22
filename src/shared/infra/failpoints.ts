import type { FailpointName, Failpoints } from '../application/failpoints';

export class FailpointError extends Error {
  constructor(readonly failpoint: FailpointName) {
    super(`failpoint ${failpoint}`);
    this.name = 'FailpointError';
  }
}

export function failpointsFrom(spec: string): Failpoints {
  const active = new Set(
    spec
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return {
    hit(name) {
      if (active.has(name)) throw new FailpointError(name);
    },
  };
}
