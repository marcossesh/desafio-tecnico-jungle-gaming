// 3 processos reais com todos os papéis, HTTP e SQS (com duplicatas) sobre as mesmas wallets.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { clusterEnv, type Instance, requestWithRetry, spawnInstance } from '../support/instance';
import { assertLedgerConsistent } from '../support/ledger';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { waitFor } from '../support/wait';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

const WALLETS = 5;
const HTTP_BETS = 20;
const SQS_BETS = 20;

let db: TestDatabase;
let sql: SQL;
let queues: TestQueues;
let instances: Instance[];

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  queues = await createTestQueues({ visibilityTimeoutSeconds: 3 });
  instances = await Promise.all(
    Array.from({ length: 3 }, () => spawnInstance(clusterEnv(db.url, queues.env))),
  );
});

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.kill('SIGTERM')));
  await assertLedgerConsistent(sql);
  await queues.destroy();
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('three instances', () => {
  test('HTTP and SQS traffic with duplicates on shared wallets applies every operation exactly once', async () => {
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, async (_, i) => {
        const res = await requestWithRetry(() => [instances[i % 3] as Instance], 'POST', '/wallets', {
          playerId: Bun.randomUUIDv7(),
          initialBalance: brl('50.00'),
        });
        expect(res.status).toBe(201);
        return res.body as { id: string; playerId: string };
      }),
    );

    const http = wallets.flatMap((wallet) =>
      Array.from({ length: HTTP_BETS }, () => ({
        providerId: 'provider-a',
        externalTransactionId: `http-${Bun.randomUUIDv7()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: brl('2.00'),
      })),
    );
    const messages = wallets.flatMap((wallet) =>
      Array.from({ length: SQS_BETS }, () => wagerMessage(wallet, { money: brl('2.00') })),
    );

    // cada requisição vai a duas instâncias diferentes; cada mensagem é entregue duas vezes
    const responses = await Promise.all([
      ...http.flatMap((body, i) =>
        [0, 1].map((copy) =>
          requestWithRetry(
            () => [instances[(i + copy) % 3] as Instance],
            'POST',
            '/wagering/transactions',
            body,
            {
              'idempotency-key': `provider-a:${body.externalTransactionId}`,
            },
          ),
        ),
      ),
      ...messages.flatMap((message) => [0, 1].map(() => queues.send(message, message.data.walletId))),
    ]);

    const statuses = responses.filter((r) => r !== undefined).map((r) => r.status);
    expect(statuses.every((status) => status === 200 || status === 422)).toBe(true);

    const total = WALLETS * (HTTP_BETS + SQS_BETS);
    await waitFor(
      async () => {
        const [row] = await sql`
          SELECT (SELECT count(*)::int FROM wager_transactions WHERE kind = 'BET') AS bets,
                 (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished`;
        return row.bets === total && row.unpublished === 0 && (await queues.inputDepth()) === 0;
      },
      { timeoutMs: 45_000, message: 'all operations applied, queue drained and outbox published' },
    );

    for (const wallet of wallets) {
      const [state] = await sql`
        SELECT w.balance, w.version,
               count(t.*) FILTER (WHERE t.kind = 'BET' AND t.status = 'PROCESSED')::int AS processed,
               count(t.*) FILTER (WHERE t.kind = 'BET' AND t.status = 'REJECTED')::int AS rejected,
               (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id AND e.direction = 'DEBIT') AS debits
          FROM wallets w JOIN wager_transactions t ON t.wallet_id = w.id
         WHERE w.id = ${wallet.id}
         GROUP BY w.id`;
      expect(state).toEqual({ balance: '0.00', version: 26, processed: 25, rejected: 15, debits: 25 });

      const reconciliation = await requestWithRetry(
        () => instances,
        'POST',
        `/wallets/${wallet.id}/reconciliation`,
      );
      expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 26 });
    }

    const [inbox] = await sql`SELECT count(*)::int AS n FROM inbox_messages`;
    expect(inbox.n).toBe(messages.length);
    const consumers = instances.filter((i) => i.logs('wager message processed').length > 0);
    expect(consumers.length).toBeGreaterThanOrEqual(2);
  }, 90_000);
});
