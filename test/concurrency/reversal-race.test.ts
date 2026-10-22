// Reversões concorrentes: várias reversões da mesma BET e reversões disputando com a própria referência.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { startTestCluster, type TestCluster } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistent } from '../support/ledger';
import { betPayload, brl, openWalletVia, submitVia } from '../support/wager-api';
import { waitFor } from '../support/wait';

let db: TestDatabase;
let sql: SQL;
let cluster: TestCluster;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  // o worker de referências roda em todas as instâncias, como em produção
  cluster = await startTestCluster(db.url, 3, {
    ROLES: 'api,scheduler',
    PENDING_REF_TICK_MS: '100',
    PENDING_REF_BASE_MS: '200',
  });
});

afterAll(async () => {
  await assertLedgerConsistent(sql);
  await cluster.close();
  await db.drop();
});

async function credits(walletId: string): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'CREDIT'`;
  return row.n;
}

describe('reversal race', () => {
  test('5 REFUNDs and 5 ROLLBACKs of the same BET in parallel credit it back exactly once', async () => {
    const wallet = await openWalletVia(cluster.request, '100.00');
    const bet = betPayload(wallet, { money: brl('30.00') });
    expect((await submitVia(cluster.request, bet)).body.status).toBe('PROCESSED');

    const reversals = Array.from({ length: 10 }, (_, i) =>
      betPayload(wallet, {
        kind: i % 2 === 0 ? 'REFUND' : 'ROLLBACK',
        money: brl('30.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const responses = await Promise.all(reversals.map((r) => submitVia(cluster.request, r)));

    expect(responses.filter((r) => r.status === 200 && r.body.status === 'PROCESSED')).toHaveLength(1);
    expect(
      responses.filter((r) => r.status === 422 && r.body.failureCode === 'REFERENCE_ALREADY_REVERSED'),
    ).toHaveLength(9);
    const [row] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(row).toEqual({ balance: '100.00', version: 3 });
    expect(await credits(wallet.id)).toBe(2); // abertura + uma reversão
  });

  test('REFUNDs sent together with their BETs all converge to PROCESSED, once each', async () => {
    const wallet = await openWalletVia(cluster.request, '1000.00');
    const pairs = Array.from({ length: 20 }, (_, round) => {
      const bet = betPayload(wallet, { money: brl('5.00'), roundId: `round-${round}` });
      const refund = betPayload(wallet, {
        kind: 'REFUND',
        money: brl('5.00'),
        roundId: `round-${round}`,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      return { bet, refund };
    });

    // a REFUND sai antes ou depois da BET conforme o agendamento; quem perde a corrida fica PENDING_REFERENCE
    const responses = await Promise.all(
      pairs.flatMap(({ bet, refund }) => [
        submitVia(cluster.request, refund),
        submitVia(cluster.request, bet),
      ]),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 202)).toBe(true);

    await waitFor(
      async () => {
        const [row] = await sql`
          SELECT count(*)::int AS n FROM wager_transactions
           WHERE wallet_id = ${wallet.id} AND status = 'PENDING_REFERENCE'`;
        return row.n === 0;
      },
      { message: 'pending reversals resolved' },
    );

    const statuses = await sql`
      SELECT kind, status, count(*)::int AS n FROM wager_transactions
       WHERE wallet_id = ${wallet.id} AND kind IN ('BET', 'REFUND') GROUP BY kind, status ORDER BY kind`;
    expect(statuses).toEqual([
      { kind: 'BET', status: 'PROCESSED', n: 20 },
      { kind: 'REFUND', status: 'PROCESSED', n: 20 },
    ]);
    const [row] = await sql`SELECT balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe('1000.00');

    // o replay de uma reversão que ficou pendente devolve o estado atual (ARCHITECTURE §19, item 7)
    const replays = await Promise.all(pairs.map(({ refund }) => submitVia(cluster.request, refund)));
    expect(
      replays.every((r) => r.status === 200 && r.body.status === 'PROCESSED' && r.body.idempotentReplay),
    ).toBe(true);
  });
});
