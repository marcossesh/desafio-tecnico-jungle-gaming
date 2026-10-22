/** Espera uma condição eventual (fila drenada, outbox publicada) sem sleeps fixos. */
export async function waitFor(
  condition: () => Promise<boolean>,
  { timeoutMs = 30_000, intervalMs = 100, message = 'condition' } = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${message}`);
}
