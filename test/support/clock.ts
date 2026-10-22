import type { Clock } from '../../src/shared/domain/ports';

/** Relógio controlado pelo teste: workers "esperam" o backoff sem sleep. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
