// A mesma aposta enviada 50× em paralelo, por 3 instâncias, debita uma única vez.
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

const PARALLEL = 50;

describe('duplicate bet', () => {
  test('50 identical requests produce one debit and 49 replays of the same result', async () => {
    const wallet = await openWalletVia(cluster.request, '100.00');
    const bet = betPayload(wallet, { money: brl('25.00') });

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () => submitVia(cluster.request, bet)),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.body.balance.amount === '75.00')).toBe(true);

    const [state] = await sql`
      SELECT w.balance, w.version,
             (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id AND e.direction = 'DEBIT') AS debits,
             (SELECT count(*)::int FROM outbox_messages o
               WHERE o.partition_key = w.id::text AND o.event_type = 'WalletBalanceChanged') AS balance_events
        FROM wallets w WHERE w.id = ${wallet.id}`;
    expect(state).toEqual({ balance: '75.00', version: 2, debits: 1, balance_events: 2 });
  });

  test('50 different keys for the same externalTransactionId: one wins, the others conflict', async () => {
    const wallet = await openWalletVia(cluster.request, '100.00');
    const bet = betPayload(wallet, { money: brl('25.00') });

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        submitVia(cluster.request, bet, `key-${i}-${bet.externalTransactionId}`),
      ),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(PARALLEL - 1);
    expect(conflicts.every((r) => r.body.error.code === 'EXTERNAL_TRANSACTION_ID_REUSED')).toBe(true);
    const [row] = await sql`SELECT balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe('75.00');
  });
});
