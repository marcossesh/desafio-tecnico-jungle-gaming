export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

/** `attempt` começa em 1. */
export function exponentialBackoffMs(attempt: number, policy: BackoffPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
