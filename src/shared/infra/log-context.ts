import { AsyncLocalStorage } from 'node:async_hooks';

export type LogContext = Record<string, string | number | null | undefined>;

const storage = new AsyncLocalStorage<LogContext>();

/** Executa `fn` com um contexto que o logger anexa a toda linha emitida dentro dela. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Enriquecer o contexto corrente (ex.: `transactionId` só é conhecido depois do processamento). */
export function addLogContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
