// Wallets distintas processadas em paralelo não interferem entre si (sem lock global).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { startTestCluster, type TestCluster } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistent } from '../support/ledger';
import { betPayload, brl, openWalletVia, submitVia } from '../support/wager-api';

let db: TestDatabase;
let sql: SQL;
let cluster: TestCluster;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  cluster = await startTestCluster(db.url);
});

afterAll(async () => {
  await assertLedgerConsistent(sql);
  await cluster.close();
  await db.drop();
});

const WALLETS = 20;
const ROUNDS = 10;

describe('parallel wallets', () => {
  test('bets and wins on 20 wallets interleaved across 3 instances all apply exactly once', async () => {
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => openWalletVia(cluster.request, '100.00')),
    );
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: ROUNDS }, (_, round) => [
        betPayload(wallet, { money: brl('7.00'), roundId: `round-${round}` }),
        betPayload(wallet, { kind: 'WIN', money: brl('2.00'), roundId: `round-${round}` }),
      ]).flat(),
    );
    // embaralha para que cada instância receba operações de várias wallets ao mesmo tempo
    requests.sort(() => Math.random() - 0.5);

    const responses = await Promise.all(requests.map((body) => submitVia(cluster.request, body)));

    expect(responses.filter((r) => r.status !== 200)).toEqual([]);
    const rows = await sql`SELECT balance, version FROM wallets WHERE id IN ${sql(wallets.map((w) => w.id))}`;
    expect(rows).toHaveLength(WALLETS);
    for (const row of rows) expect(row).toEqual({ balance: '50.00', version: 1 + 2 * ROUNDS });
  });
});
