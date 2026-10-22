// Logs com contexto e sem valores, métricas em /metrics e readiness com timeout e drain.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { HealthController } from '../../src/health/health.controller';
import { failpointsFrom } from '../../src/shared/infra/failpoints';
import { createLogger } from '../../src/shared/infra/logger';
import { SqsConsumer } from '../../src/wagering/infra/sqs-consumer';
import { startTestApp, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { failure } from '../support/failure';
import { assertLedgerConsistent } from '../support/ledger';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { betCommand, createUseCases, type UseCases } from '../support/wagering';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

let db: TestDatabase;
let sql: SQL;
let api: TestApp;
let useCases: UseCases;
let queues: TestQueues;
const logs: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  api = await startTestApp(db.url, {}, { logs });
  useCases = await createUseCases(db.url);
  queues = await createTestQueues({ visibilityTimeoutSeconds: 5 });
});

afterAll(async () => {
  await assertLedgerConsistent(sql);
  await api.close();
  await useCases.close();
  await queues.destroy();
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const parsed = () => logs.map((line) => JSON.parse(line) as Record<string, unknown>);

async function scrape(): Promise<string> {
  const res = await fetch(`${await api.app.getUrl()}/metrics`);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

function sample(metrics: string, series: string): number | undefined {
  const line = metrics.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('HTTP observability', () => {
  test('request logs carry the correlation and business context, never amounts or balances', async () => {
    const wallet = (
      await api.request('POST', '/wallets', { playerId: Bun.randomUUIDv7(), initialBalance: brl('1000.00') })
    ).body;
    const body = {
      providerId: 'provider-a',
      externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
    };
    const headers = {
      'idempotency-key': `provider-a:${body.externalTransactionId}`,
      'x-correlation-id': 'corr-obs',
    };
    const bet = await api.request('POST', '/wagering/transactions', body, headers);
    await api.request('POST', '/wagering/transactions', body, headers); // replay
    await api.request('POST', '/wagering/transactions', { ...body, money: brl('26.00') }, headers); // conflito
    await api.request(
      'POST',
      '/wagering/transactions',
      { ...body, externalTransactionId: `tx-${Bun.randomUUIDv7()}`, money: brl('5000.00') },
      { 'idempotency-key': `k-${Bun.randomUUIDv7()}` },
    );
    await api.request('POST', `/wallets/${wallet.id}/reconciliation`);
    await Bun.sleep(50); // a linha de log é escrita no 'finish' da resposta

    const requests = parsed().filter((l) => l.msg === 'http request' && l.path === '/wagering/transactions');
    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      correlationId: 'corr-obs',
      channel: 'http',
      transactionId: bet.body.transactionId,
      walletId: wallet.id,
      providerId: 'provider-a',
      kind: 'BET',
      status: 'PROCESSED',
      statusCode: 200,
      durationMs: expect.any(Number),
    });
    expect(requests[1]).toMatchObject({ idempotentReplay: 'true', transactionId: bet.body.transactionId });
    expect(requests[2]).toMatchObject({ statusCode: 409, walletId: wallet.id });
    expect(requests[3]).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      statusCode: 422,
    });

    for (const line of logs) {
      for (const amount of ['1000.00', '975.00', '25.00', '26.00', '5000.00'])
        expect(line).not.toContain(amount);
      expect(line).not.toContain('"amount"');
    }
  });

  test('/metrics exposes transactions by status, replays, conflicts and latency', async () => {
    const metrics = await scrape();
    expect(sample(metrics, 'wager_transactions_total{kind="BET",status="PROCESSED",channel="http"}')).toBe(1);
    expect(sample(metrics, 'wager_transactions_total{kind="BET",status="REJECTED",channel="http"}')).toBe(1);
    expect(sample(metrics, 'idempotent_replays_total{channel="http"}')).toBe(1);
    expect(sample(metrics, 'idempotency_conflicts_total{code="IDEMPOTENCY_KEY_REUSED"}')).toBe(1);
    expect(
      sample(metrics, 'wager_processing_duration_seconds_count{kind="BET",channel="http",outcome="new"}'),
    ).toBe(2);
    expect(
      sample(metrics, 'wager_processing_duration_seconds_count{kind="BET",channel="http",outcome="error"}'),
    ).toBe(1);
    expect(sample(metrics, 'reconciliation_divergences_total')).toBe(0);
  });
});

describe('worker and consumer observability', () => {
  test('lock conflicts and retries are counted', async () => {
    const wallet = await useCases.openWallet('100.00');
    let release = () => {};
    let ready = () => {};
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await acquired;
    const error = await failure(
      useCases
        .processWager([], { lockTimeoutMs: 100, maxAttempts: 2 })
        .execute(betCommand(wallet), `k-${Bun.randomUUIDv7()}`, { channel: 'http', correlationId: 'c' }),
    );
    release();
    await holder;

    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT' });
    const metrics = await useCases.metrics.registry.metrics();
    expect(sample(metrics, 'wallet_lock_conflicts_total{reason="lock_timeout"}')).toBe(2);
    expect(sample(metrics, 'processing_retries_total{component="process_wager",reason="lock_timeout"}')).toBe(
      1,
    );
  });

  test('consumer logs carry messageId and transaction context; SQS outcomes and DLQ are counted', async () => {
    const consumerLogs: string[] = [];
    const consumer = new SqsConsumer(
      queues.sqs,
      useCases.processWager(),
      failpointsFrom(''),
      useCases.metrics,
      createLogger('info', { write: (line: string) => void consumerLogs.push(line) }),
      {
        consumerName: 'wager-consumer',
        queues: { input: queues.urls.input, dlq: queues.urls.dlq },
        maxAttempts: 3,
        retryBaseSeconds: 1,
        waitTimeSeconds: 1,
        maxMessages: 10,
        shutdownGraceMs: 5_000,
      },
    );
    const wallet = await useCases.openWallet('100.00');
    const message = wagerMessage(wallet, { money: brl('12.34') });
    await queues.send(message, wallet.id);
    await queues.send(message, wallet.id); // reentrega → inbox
    await queues.send({ ...message, type: 'Unknown' }, wallet.id); // permanente → DLQ
    while ((await consumer.runOnce()) > 0) {}

    const processed = consumerLogs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'wager message processed');
    expect(processed.map((l) => l.outcome)).toEqual(['new', 'duplicate_message']);
    expect(processed[0]).toMatchObject({
      channel: 'sqs',
      messageId: message.messageId,
      correlationId: message.messageId,
      walletId: wallet.id,
      providerId: 'provider-a',
      transactionId: expect.any(String),
      status: 'PROCESSED',
    });
    for (const line of consumerLogs) expect(line).not.toContain('12.34');

    const metrics = await useCases.metrics.registry.metrics();
    expect(sample(metrics, 'sqs_messages_total{outcome="ack"}')).toBe(2);
    expect(sample(metrics, 'sqs_messages_total{outcome="dlq"}')).toBe(1);
    expect(sample(metrics, 'sqs_dlq_messages_total{reason="VALIDATION_ERROR"}')).toBe(1);
    expect(sample(metrics, 'inbox_duplicates_total{consumer="wager-consumer"}')).toBe(1);
    expect(sample(metrics, 'sqs_dlq_depth')).toBe(1);
  });

  test('the pending reference gauge follows the backlog', async () => {
    const wallet = await useCases.openWallet('100.00');
    await useCases
      .processWager()
      .execute(
        betCommand(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'never' }),
        `k-${Bun.randomUUIDv7()}`,
        { channel: 'http', correlationId: 'c' },
      );
    await useCases.reprocess({ now: () => new Date() }).runOnce();
    const [row] =
      await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`;
    expect(sample(await useCases.metrics.registry.metrics(), 'pending_reference_transactions')).toBe(row.n);
  });
});

describe('readiness', () => {
  test('ready when Postgres and SQS answer', async () => {
    const res = await api.request('GET', '/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'ok', sqs: 'ok' } });
  });

  test('an unreachable SQS makes the instance unready within the probe timeout', async () => {
    const unready = await startTestApp(db.url, { SQS_ENDPOINT: 'http://10.255.255.1:4566' });
    try {
      const startedAt = performance.now();
      const res = await unready.request('GET', '/health/ready');
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'unavailable', checks: { database: 'ok' } });
      expect(['error', 'timeout']).toContain(res.body.checks.sqs);
    } finally {
      await unready.close();
    }
  });

  test('a draining instance reports 503 while liveness stays green', async () => {
    const draining = await startTestApp(db.url);
    try {
      draining.app.get(HealthController).beforeApplicationShutdown();
      expect(await draining.request('GET', '/health/ready')).toMatchObject({
        status: 503,
        body: { status: 'draining' },
      });
      expect((await draining.request('GET', '/health/live')).status).toBe(200);
    } finally {
      await draining.close();
    }
  });
});
