// Teste de carga: hot wallet × wallets distribuídas contra 3 instâncias reais; relatório em test/load/results/.
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { createTestDatabase } from '../support/database';
import { clusterEnv, type Instance, spawnInstance } from '../support/instance';
import { createTestQueues } from '../support/queues';
import { waitFor } from '../support/wait';

const config = {
  instances: Number(process.env.LOAD_INSTANCES ?? 3),
  outboxInstances: Number(process.env.LOAD_OUTBOX_INSTANCES ?? 0),
  // req/s alvo somado entre os usuários virtuais; 0 = sem limite (loop fechado puro)
  rate: Number(process.env.LOAD_RATE ?? 0),
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 32),
  durationS: Number(process.env.LOAD_DURATION_S ?? 20),
  warmupS: Number(process.env.LOAD_WARMUP_S ?? 3),
  wallets: Number(process.env.LOAD_WALLETS ?? 100),
  scenarios: (process.env.LOAD_SCENARIOS ?? 'distributed,hot').split(','),
};

interface ScenarioResult {
  scenario: string;
  wallets: number;
  requests: number;
  throughput: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  statuses: Record<string, number>;
  errorRate: number;
  networkErrors: number;
  lockConflicts: number;
  retries: number;
  maxLockWaiters: number;
  outboxLagS: { p50: number; p99: number; max: number };
  outboxDrainS: number;
  consistent: boolean;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0);
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

async function scrapeSum(instances: Instance[], metric: string): Promise<number> {
  let total = 0;
  for (const instance of instances) {
    const text = await (await fetch(`${instance.baseUrl}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(`${metric}{`) || line.startsWith(`${metric} `))
        total += Number(line.split(' ').at(-1));
    }
  }
  return total;
}

const db = await createTestDatabase();
// defaults de produção (pool 10, ticks padrão), não os valores acelerados dos testes
const productionDefaults = {
  DB_POOL_MAX: '10',
  OUTBOX_TICK_MS: '500',
  PENDING_REF_TICK_MS: '1000',
};

let instances: Instance[] = [];
let next = 0;
const target = () => instances[next++ % instances.length] as Instance;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${target().baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// Filas novas por cenário: no MiniStack o envio FIFO custa O(enviadas nos últimos 5 min), e o próximo herdaria o custo.
async function runScenario(scenario: string): Promise<ScenarioResult> {
  const queues = await createTestQueues({ visibilityTimeoutSeconds: 30 });
  const env = { ...clusterEnv(db.url, queues.env), ...productionDefaults };
  const dedicatedOutbox = config.outboxInstances > 0;
  const apiInstances = await Promise.all(
    Array.from({ length: config.instances }, () =>
      spawnInstance(dedicatedOutbox ? { ...env, ROLES: 'api,consumer,scheduler' } : env),
    ),
  );
  const outboxInstances = await Promise.all(
    Array.from({ length: config.outboxInstances }, () => spawnInstance({ ...env, ROLES: 'outbox' })),
  );
  instances = apiInstances;
  const all = [...apiInstances, ...outboxInstances];

  // consumidor downstream dos eventos
  let sinking = true;
  const eventSink = Promise.all(
    Array.from({ length: 4 }, async () => {
      while (sinking) {
        const { Messages = [] } = await queues.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queues.urls.events,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        if (Messages.length === 0) continue;
        await queues.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queues.urls.events,
            Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
          }),
        );
      }
    }),
  );

  try {
    return await measureScenario(scenario, all);
  } finally {
    sinking = false;
    await eventSink;
    await Promise.all(all.map((instance) => instance.kill('SIGTERM')));
    await queues.destroy();
  }
}

async function measureScenario(scenario: string, all: Instance[]): Promise<ScenarioResult> {
  const walletCount = scenario === 'hot' ? 1 : config.wallets;
  const wallets = await Promise.all(
    Array.from({ length: walletCount }, async () => {
      const res = await post('/wallets', {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: '100000000.00', currency: 'BRL' },
      });
      return (await res.json()) as { id: string; playerId: string };
    }),
  );

  const before = {
    conflicts: await scrapeSum(all, 'wallet_lock_conflicts_total'),
    retries: await scrapeSum(all, 'processing_retries_total'),
  };
  let maxLockWaiters = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [row] = await db.sql`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      maxLockWaiters = Math.max(maxLockWaiters, row.n);
      await Bun.sleep(100);
    }
  })();

  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let networkErrors = 0;
  const startedAt = performance.now();
  const measureFrom = startedAt + config.warmupS * 1_000;
  const endAt = measureFrom + config.durationS * 1_000;
  const windowStart = new Date(Date.now() + config.warmupS * 1_000);

  let nextSlot = startedAt;
  const virtualUser = async () => {
    while (performance.now() < endAt) {
      if (config.rate > 0) {
        const slot = nextSlot;
        nextSlot += 1_000 / config.rate;
        const wait = slot - performance.now();
        if (wait > 0) await Bun.sleep(wait);
      }
      const wallet = wallets[Math.floor(Math.random() * wallets.length)] as { id: string; playerId: string };
      const externalTransactionId = `load-${Bun.randomUUIDv7()}`;
      const sentAt = performance.now();
      let status = 'network_error';
      try {
        const res = await post(
          '/wagering/transactions',
          {
            providerId: 'provider-load',
            externalTransactionId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-1',
            gameId: 'load',
            kind: 'BET',
            money: { amount: '1.00', currency: 'BRL' },
          },
          { 'idempotency-key': `provider-load:${externalTransactionId}` },
        );
        await res.arrayBuffer();
        status = String(res.status);
      } catch {
        networkErrors += 1;
      }
      if (sentAt >= measureFrom) {
        latencies.push(performance.now() - sentAt);
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, virtualUser));
  sampling = false;
  await sampler;

  const drainStartedAt = performance.now();
  await waitFor(
    async () => {
      const [row] = await db.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
      return row.n === 0;
    },
    { timeoutMs: 120_000, intervalMs: 200, message: 'outbox drained' },
  );
  const outboxDrainS = (performance.now() - drainStartedAt) / 1_000;
  const [lag] = await db.sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM published_at - occurred_at)) AS p50,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM published_at - occurred_at)) AS p99,
           max(extract(epoch FROM published_at - occurred_at)) AS max
      FROM outbox_messages WHERE occurred_at >= ${windowStart}`;

  let consistent = true;
  for (const wallet of wallets) {
    const res = await post(`/wallets/${wallet.id}/reconciliation`, undefined);
    consistent &&= ((await res.json()) as { consistent: boolean }).consistent;
  }

  latencies.sort((a, b) => a - b);
  const requests = latencies.length;
  const ok = (statuses['200'] ?? 0) + (statuses['422'] ?? 0);
  return {
    scenario,
    wallets: walletCount,
    requests,
    throughput: round(requests / config.durationS),
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.at(-1) ?? 0),
    },
    statuses,
    errorRate: round(((requests - ok) / Math.max(requests, 1)) * 100, 2),
    networkErrors,
    lockConflicts: (await scrapeSum(all, 'wallet_lock_conflicts_total')) - before.conflicts,
    retries: (await scrapeSum(all, 'processing_retries_total')) - before.retries,
    maxLockWaiters,
    outboxLagS: {
      p50: round(Number(lag.p50), 3),
      p99: round(Number(lag.p99), 3),
      max: round(Number(lag.max), 3),
    },
    outboxDrainS: round(outboxDrainS, 2),
    consistent,
  };
}

try {
  const [pg] = await db.sql`SHOW server_version`;
  const environment = {
    date: new Date().toISOString(),
    cpu: `${os.cpus()[0]?.model} (${os.cpus().length} threads)`,
    memoryGb: round(os.totalmem() / 1024 ** 3),
    os: `${os.type()} ${os.release()}`,
    bun: Bun.version,
    postgres: pg.server_version,
    setup: `${
      config.outboxInstances > 0
        ? `${config.instances} instâncias api/consumer/scheduler + ${config.outboxInstances} só outbox`
        : `${config.instances} instâncias (todos os papéis)`
    }, pool ${productionDefaults.DB_POOL_MAX} cada, lock_timeout 3s; filas e instâncias novas por cenário; Postgres e MiniStack em Docker, gerador no mesmo host`,
    load: `${config.concurrency} usuários virtuais em loop fechado${config.rate > 0 ? ` limitados a ${config.rate} req/s` : ''}, ${config.durationS}s medidos após ${config.warmupS}s de aquecimento, BET de 1.00`,
    events: 'fila de eventos consumida em paralelo por 4 leitores (downstream simulado)',
  };
  const results: ScenarioResult[] = [];
  for (const scenario of config.scenarios) {
    console.log(`running ${scenario}…`);
    results.push(await runScenario(scenario));
  }

  const table = [
    '| Cenário | Wallets | Req | req/s | p50 ms | p95 ms | p99 ms | max ms | Erros % | Status | Conflitos de lock | Retries | Máx. esperando lock | Outbox lag p50/p99/max s | Drenagem s | Consistente |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.scenario} | ${r.wallets} | ${r.requests} | ${r.throughput} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} | ${r.errorRate} | ${Object.entries(
          r.statuses,
        )
          .map(([s, n]) => `${s}: ${n}`)
          .join(
            ', ',
          )} | ${r.lockConflicts} | ${r.retries} | ${r.maxLockWaiters} | ${r.outboxLagS.p50} / ${r.outboxLagS.p99} / ${r.outboxLagS.max} | ${r.outboxDrainS} | ${r.consistent ? 'sim' : 'NÃO'} |`,
    ),
  ].join('\n');
  const report = `# Teste de carga — ${environment.date}\n\n${Object.entries(environment)
    .map(([key, value]) => `- **${key}:** ${value}`)
    .join('\n')}\n\n${table}\n`;

  await mkdir('test/load/results', { recursive: true });
  const stamp = environment.date.replaceAll(/[:.]/g, '-');
  await Bun.write(
    `test/load/results/${stamp}.json`,
    JSON.stringify({ environment, config, results }, null, 2),
  );
  await Bun.write(`test/load/results/${stamp}.md`, report);
  console.log(`\n${report}`);
  if (results.some((r) => !r.consistent)) process.exitCode = 1;
} finally {
  await db.drop();
}
