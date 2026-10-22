import type { Subprocess } from 'bun';
import type { ApiResponse } from './app';

/** Instância real da aplicação (`bun src/main.ts`) em processo separado. */
export interface Instance {
  port: number;
  baseUrl: string;
  process: Subprocess;
  output(): string;
  /** Linhas JSON de log com `msg` igual ao informado. */
  logs(msg: string): Record<string, unknown>[];
  kill(signal: 'SIGKILL' | 'SIGTERM'): Promise<number | null>;
}

const STARTUP_TIMEOUT_MS = 20_000;

export async function spawnInstance(env: Record<string, string>): Promise<Instance> {
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: '0', LOG_LEVEL: 'info', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let resolvePort: (port: number) => void = () => {};
  const started = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  // ler sempre: pipe cheio bloquearia o processo filho
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      const match = /"port":(\d+)[^\n]*"msg":"wagering-processor started"/.exec(output);
      if (match) resolvePort(Number(match[1]));
    }
  };
  void pump(child.stdout);
  void pump(child.stderr);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const port = await Promise.race([
    started,
    child.exited.then((code) => {
      throw new Error(`instance exited (${code}) before starting:\n${output}`);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`instance did not start in ${STARTUP_TIMEOUT_MS}ms:\n${output}`)),
        STARTUP_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    process: child,
    output: () => output,
    logs: (msg) =>
      output
        .split('\n')
        .filter((line) => line.includes(`"msg":"${msg}"`))
        .map((line) => JSON.parse(line)),
    async kill(signal) {
      child.kill(signal);
      return child.exited;
    },
  };
}

/**
 * Cliente de provedor: em falha de rede ou 503 reenvia a mesma requisição (mesma Idempotency-Key)
 * para outra instância, como faria um provedor real.
 */
export async function requestWithRetry(
  instances: () => Instance[],
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  attempts = 80,
): Promise<ApiResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pool = instances();
    const target = pool[attempt % pool.length];
    if (!target) throw new Error('no instances');
    try {
      const res = await fetch(`${target.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (res.status !== 503)
        return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
      lastError = new Error(`503 ${text}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw lastError;
}

/** Configuração de uma instância completa (todos os papéis) com workers rápidos para teste. */
export function clusterEnv(databaseUrl: string, queueEnv: Record<string, string>): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    ...queueEnv,
    ROLES: 'api,consumer,outbox,scheduler',
    DB_POOL_MAX: '4',
    OUTBOX_TICK_MS: '100',
    PENDING_REF_TICK_MS: '200',
    PENDING_REF_BASE_MS: '300',
    SQS_RETRY_BASE_SECONDS: '1',
    SHUTDOWN_GRACE_MS: '5000',
  };
}
