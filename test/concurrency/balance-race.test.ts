// Cenário obrigatório: saldo 100.00, duas apostas de 80.00 simultâneas.
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

async function debits(walletId: string): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
  return row.n;
}

describe('balance race', () => {
  test('100.00 vs 2 × 80.00: exactly one PROCESSED, one INSUFFICIENT_FUNDS, final 20.00, one debit', async () => {
    const wallet = await openWalletVia(cluster.request, '100.00');
    const bets = [betPayload(wallet, { money: brl('80.00') }), betPayload(wallet, { money: brl('80.00') })];

    const responses = await Promise.all(bets.map((bet) => submitVia(cluster.request, bet)));

    const statuses = responses.map((r) => `${r.status} ${r.body.status} ${r.body.failureCode}`).sort();
    expect(statuses).toEqual(['200 PROCESSED null', '422 REJECTED INSUFFICIENT_FUNDS']);
    const [row] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(row).toEqual({ balance: '20.00', version: 2 });
    expect(await debits(wallet.id)).toBe(1);

    // retries do provedor não duplicam o débito e devolvem o resultado original
    const retries = await Promise.all(
      bets.flatMap((bet) => [submitVia(cluster.request, bet), submitVia(cluster.request, bet)]),
    );
    expect(retries.every((r) => r.body.idempotentReplay)).toBe(true);
    expect(retries.map((r) => r.body.status).sort()).toEqual([
      'PROCESSED',
      'PROCESSED',
      'REJECTED',
      'REJECTED',
    ]);
    expect(await debits(wallet.id)).toBe(1);
  });

  test('100 bets of 1.00 against 50.00: exactly 50 debits and a zero balance', async () => {
    const wallet = await openWalletVia(cluster.request, '50.00');
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        submitVia(cluster.request, betPayload(wallet, { money: brl('1.00') })),
      ),
    );

    expect(responses.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(50);
    expect(responses.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(50);
    const [row] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(row).toEqual({ balance: '0.00', version: 51 });
    expect(await debits(wallet.id)).toBe(50);
  });
});
