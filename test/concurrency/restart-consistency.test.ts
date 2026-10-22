// Carga contínua enquanto instâncias levam SIGKILL e são reiniciadas; no fim tudo converge e reconcilia.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { clusterEnv, type Instance, requestWithRetry, spawnInstance } from '../support/instance';
import { assertLedgerConsistent } from '../support/ledger';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { waitFor } from '../support/wait';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

const WALLETS = 4;
const LOAD_MS = 6_000;
const KILL_EVERY_MS = 800;
const MIN_KILLS = 4;

let db: TestDatabase;
let sql: SQL;
let queues: TestQueues;
let env: Record<string, string>;
let instances: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  queues = await createTestQueues({ visibilityTimeoutSeconds: 2, maxAttempts: 10 });
  env = clusterEnv(db.url, queues.env);
  instances = await Promise.all(Array.from({ length: 3 }, () => spawnInstance(env)));
});

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.kill('SIGTERM')));
  await queues.destroy();
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;

test('SIGKILL of random instances under load still converges to consistent wallets', async () => {
  const wallets = await Promise.all(
    Array.from({ length: WALLETS }, async () => {
      const res = await requestWithRetry(() => instances, 'POST', '/wallets', {
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('1000.00'),
      });
      return res.body as { id: string; playerId: string };
    }),
  );

  const operations: string[] = [];
  let loading = true;
  let kills = 0;

  const chaos = (async () => {
    while (loading) {
      await Bun.sleep(KILL_EVERY_MS);
      if (!loading) break;
      const victim = pick(instances);
      instances = instances.filter((instance) => instance !== victim);
      await victim.kill('SIGKILL');
      kills += 1;
      instances.push(await spawnInstance(env));
    }
  })();

  const httpProducer = async () => {
    while (loading) {
      const wallet = pick(wallets);
      const betId = `http-${Bun.randomUUIDv7()}`;
      const body = {
        providerId: 'provider-a',
        externalTransactionId: betId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: brl('3.00'),
      };
      // REFUND antes da BET: obriga o worker de referências a resolver no meio do caos
      const refundFirst = Math.random() < 0.3;
      const refund = {
        ...body,
        externalTransactionId: `refund-${betId}`,
        kind: 'REFUND',
        referenceExternalTransactionId: betId,
      };
      const submit = (payload: typeof body) =>
        requestWithRetry(() => instances, 'POST', '/wagering/transactions', payload, {
          'idempotency-key': `provider-a:${payload.externalTransactionId}`,
        });
      if (refundFirst) {
        expect([202]).toContain((await submit(refund)).status);
        operations.push(refund.externalTransactionId);
      }
      expect([200]).toContain((await submit(body)).status);
      operations.push(betId);
    }
  };

  const sqsProducer = async () => {
    while (loading) {
      const message = wagerMessage(pick(wallets), { money: brl('1.00') });
      await queues.send(message, message.data.walletId);
      await queues.send(message, message.data.walletId); // reentrega
      operations.push(message.data.externalTransactionId);
      await Bun.sleep(20);
    }
  };

  const producers = [httpProducer(), httpProducer(), httpProducer(), sqsProducer()];
  // tempo mínimo de carga E número mínimo de kills: respawn fica mais lento com a máquina ocupada
  await Bun.sleep(LOAD_MS);
  while (kills < MIN_KILLS) await Bun.sleep(100);
  loading = false;
  await Promise.all([...producers, chaos]);
  expect(operations.length).toBeGreaterThan(200);

  await waitFor(
    async () => {
      const [row] = await sql`
        SELECT (SELECT count(*)::int FROM wager_transactions WHERE provider_id <> 'internal') AS transactions,
               (SELECT count(*)::int FROM wager_transactions WHERE status = 'PENDING_REFERENCE') AS pending,
               (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished`;
      return (
        row.transactions === operations.length &&
        row.pending === 0 &&
        row.unpublished === 0 &&
        (await queues.inputDepth()) === 0
      );
    },
    { timeoutMs: 60_000, message: 'queues drained, references resolved and outbox published' },
  );

  // cada operação existe exatamente uma vez e cada efeito no saldo tem exatamente um lançamento
  const [totals] = await sql`
    SELECT count(DISTINCT external_transaction_id)::int AS distinct_ops,
           count(*) FILTER (WHERE status = 'PROCESSED' AND kind <> 'LOSS')::int AS balance_moves,
           (SELECT count(*)::int FROM wallet_ledger_entries) AS entries,
           count(*) FILTER (WHERE status NOT IN ('PROCESSED'))::int AS not_processed
      FROM wager_transactions`;
  expect(totals.distinct_ops).toBe(operations.length + WALLETS);
  expect(totals.entries).toBe(totals.balance_moves);
  expect(totals.not_processed).toBe(0);

  for (const wallet of wallets) {
    const res = await requestWithRetry(() => instances, 'POST', `/wallets/${wallet.id}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: true, issues: [] });
  }
  await assertLedgerConsistent(sql);
}, 120_000);
