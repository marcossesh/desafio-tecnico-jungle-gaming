import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/app';
import { loadEnv } from '../../src/config/env';
import { METRICS } from '../../src/shared/infra/core.module';
import { createLogger } from '../../src/shared/infra/logger';
import type { PromMetrics } from '../../src/shared/infra/metrics';

export interface ApiResponse {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: corpo JSON arbitrário inspecionado pelos testes
  body: any;
}

export interface TestApp {
  app: INestApplication;
  metrics: PromMetrics;
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** Só o papel `api` por padrão: workers em background interfeririam nas asserções; testes os ligam via `env`. */
export async function startTestApp(
  databaseUrl: string,
  env: Record<string, string> = {},
  options: { logs?: string[] } = {},
): Promise<TestApp> {
  const config = loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    DB_POOL_MAX: '5',
    ROLES: 'api',
    ...env,
  });
  const { logs } = options;
  const logger = logs
    ? createLogger('info', { write: (line: string) => void logs.push(line) })
    : createLogger(process.env.TEST_LOG_LEVEL ?? 'silent');
  const app = await createApp(config, logger);
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  return {
    app,
    metrics: app.get<PromMetrics>(METRICS),
    async request(method, path, body, headers = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
    },
    close: () => app.close(),
  };
}

/** N instâncias da app no mesmo banco, cada uma com seu pool; requisições distribuídas em round-robin. */
export async function startTestCluster(databaseUrl: string, size = 3) {
  const apps = await Promise.all(Array.from({ length: size }, () => startTestApp(databaseUrl)));
  let next = 0;
  return {
    apps,
    request: (...args: Parameters<TestApp['request']>) => {
      const app = apps[next++ % apps.length];
      if (!app) throw new Error('empty cluster');
      return app.request(...args);
    },
    close: () => Promise.all(apps.map((app) => app.close())),
  };
}

export type TestCluster = Awaited<ReturnType<typeof startTestCluster>>;
