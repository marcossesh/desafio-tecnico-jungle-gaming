import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { startTestApp, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { applyEntry, assertLedgerConsistent } from '../support/ledger';

let db: TestDatabase;
let sql: SQL;
let api: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  api = await startTestApp(db.url);
});

afterAll(async () => {
  await assertLedgerConsistent(sql);
  await api.close();
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(amount = '100.00', playerId: string = Bun.randomUUIDv7()) {
  const res = await api.request('POST', '/wallets', { playerId, initialBalance: brl(amount) });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

async function divergenceCount(): Promise<number> {
  const metric = api.metrics.registry.getSingleMetric('reconciliation_divergences_total');
  return (await metric?.get())?.values[0]?.value ?? 0;
}

// Simula corrupção por fora da aplicação: triggers desligados só nesta transação (requer superusuário).
async function corrupt(statement: (tx: SQL) => Promise<unknown>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await statement(tx);
  });
}

describe('POST /wallets', () => {
  test('opens a funded wallet with OPENING transaction, ledger entry and outbox event atomically', async () => {
    const playerId = Bun.randomUUIDv7();
    const res = await api.request(
      'POST',
      '/wallets',
      { playerId, initialBalance: brl('1000.00') },
      { 'x-correlation-id': 'corr-open-1' },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe('corr-open-1');
    expect(res.body).toMatchObject({ playerId, balance: brl('1000.00'), version: 1 });
    const walletId = res.body.id;

    const [opening] = await sql`
      SELECT kind, provider_id, status, amount, external_transaction_id, correlation_id
        FROM wager_transactions WHERE wallet_id = ${walletId}`;
    expect(opening).toEqual({
      kind: 'OPENING',
      provider_id: 'internal',
      status: 'PROCESSED',
      amount: '1000.00',
      external_transaction_id: `opening:${walletId}`,
      correlation_id: 'corr-open-1',
    });
    const entries = await sql`
      SELECT wallet_version, direction, amount, balance_before, balance_after
        FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
    expect(entries).toEqual([
      {
        wallet_version: 1,
        direction: 'CREDIT',
        amount: '1000.00',
        balance_before: '0.00',
        balance_after: '1000.00',
      },
    ]);
    const [event] = await sql`
      SELECT event_type, aggregate_id, partition_key, payload, published_at
        FROM outbox_messages WHERE aggregate_id = ${walletId}`;
    expect(event).toMatchObject({
      event_type: 'WalletBalanceChanged',
      partition_key: walletId,
      published_at: null,
      payload: {
        eventType: 'WalletBalanceChanged',
        correlationId: 'corr-open-1',
        version: 1,
        data: {
          walletId,
          direction: 'CREDIT',
          balanceBefore: brl('0.00'),
          balanceAfter: brl('1000.00'),
          walletVersion: 1,
        },
      },
    });
  });

  test('an empty wallet has no transaction, entry or event', async () => {
    const { id } = await openWallet('0.00');
    const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${id}) AS transactions,
             (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${id}) AS entries,
             (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${id}) AS events`;
    expect(counts).toEqual({ transactions: 0, entries: 0, events: 0 });
  });

  test('a second wallet for the same player and currency is a conflict and writes nothing', async () => {
    const { playerId } = await openWallet('10.00');
    const [before] = await sql`SELECT count(*)::int AS n FROM outbox_messages`;

    const res = await api.request('POST', '/wallets', { playerId, initialBalance: brl('5.00') });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
    expect(res.body.correlationId).toBe(res.headers.get('x-correlation-id'));

    const [after] = await sql`SELECT count(*)::int AS n FROM outbox_messages`;
    expect(after).toEqual(before);
    const usd = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
  });

  test('concurrent duplicates create exactly one wallet', async () => {
    const playerId = Bun.randomUUIDv7();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api.request('POST', '/wallets', { playerId, initialBalance: brl('50.00') }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, ...Array(9).fill(409)]);
    const [row] = await sql`SELECT count(*)::int AS n FROM wallets WHERE player_id = ${playerId}`;
    expect(row.n).toBe(1);
  });

  test.each<[string, unknown, string]>([
    ['more than 2 decimals', { amount: '10.001', currency: 'BRL' }, 'INVALID_MONEY'],
    ['negative amount', { amount: '-1.00', currency: 'BRL' }, 'INVALID_MONEY'],
    ['scientific notation', { amount: '1e3', currency: 'BRL' }, 'INVALID_MONEY'],
    ['numeric amount', { amount: 10, currency: 'BRL' }, 'INVALID_MONEY'],
    ['lowercase currency', { amount: '10.00', currency: 'brl' }, 'INVALID_MONEY'],
    ['missing initial balance', undefined, 'VALIDATION_ERROR'],
  ])('rejects %s with 400', async (_name, initialBalance, code) => {
    const res = await api.request('POST', '/wallets', { playerId: Bun.randomUUIDv7(), initialBalance });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code, retryable: false });
  });

  test('rejects a malformed playerId and a malformed JSON body with 400', async () => {
    const badPlayer = await api.request('POST', '/wallets', { playerId: 'p-1', initialBalance: brl('1.00') });
    expect(badPlayer.status).toBe(400);
    expect(badPlayer.body.error.code).toBe('VALIDATION_ERROR');

    const badJson = await api.request('POST', '/wallets', '{"playerId":');
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId', () => {
  test('returns the wallet view', async () => {
    const { id, playerId } = await openWallet('42.50');
    await applyEntry(sql, id, 'DEBIT', '2.50');

    const res = await api.request('GET', `/wallets/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, playerId, balance: brl('40.00'), version: 2 });
  });

  test('unknown wallet is 404 and malformed id is 400', async () => {
    const missing = await api.request('GET', `/wallets/${Bun.randomUUIDv7()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');

    const malformed = await api.request('GET', '/wallets/not-a-uuid');
    expect(malformed.status).toBe(400);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('pages newest first with a stable opaque cursor', async () => {
    const { id } = await openWallet('100.00');
    for (const amount of ['1.00', '2.00', '3.00', '4.00']) await applyEntry(sql, id, 'CREDIT', amount);

    const versions: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res = await api.request('GET', `/wallets/${id}/ledger${query}`);
      expect(res.status).toBe(200);
      versions.push(...res.body.items.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = res.body.nextCursor;
      // um movimento novo no meio da paginação não desloca as páginas seguintes
      if (versions.length === 2) await applyEntry(sql, id, 'CREDIT', '5.00');
    } while (cursor);

    expect(versions).toEqual([5, 4, 3, 2, 1]);
    const first = await api.request('GET', `/wallets/${id}/ledger?limit=1`);
    expect(first.body.items[0]).toMatchObject({
      walletVersion: 6,
      direction: 'CREDIT',
      money: brl('5.00'),
      balanceBefore: brl('110.00'),
      balanceAfter: brl('115.00'),
    });
  });

  test('a wallet without entries has an empty page', async () => {
    const { id } = await openWallet('0.00');
    const res = await api.request('GET', `/wallets/${id}/ledger`);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test.each(['limit=0', 'limit=201', 'limit=abc', 'cursor=bm90LWpzb24', 'cursor=eyJ2IjotMX0'])(
    '%s is rejected with 400',
    async (query) => {
      const { id } = await openWallet('1.00');
      const res = await api.request('GET', `/wallets/${id}/ledger?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  test('unknown wallet is 404', async () => {
    const res = await api.request('GET', `/wallets/${Bun.randomUUIDv7()}/ledger`);
    expect(res.status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('a consistent wallet reports zero difference and the number of checked entries', async () => {
    const { id } = await openWallet('975.00');
    await applyEntry(sql, id, 'DEBIT', '25.00');
    await applyEntry(sql, id, 'CREDIT', '50.00');
    const before = await divergenceCount();

    const res = await api.request('POST', `/wallets/${id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: id,
      storedBalance: brl('1000.00'),
      calculatedBalance: brl('1000.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 3,
      issues: [],
    });
    expect(await divergenceCount()).toBe(before);
  });

  test('an empty wallet is consistent', async () => {
    const { id } = await openWallet('0.00');
    const res = await api.request('POST', `/wallets/${id}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: true, checkedEntries: 0, difference: brl('0.00') });
  });

  test('a balance changed behind the ledger is flagged, counted and never corrected', async () => {
    const { id } = await openWallet('100.00');
    await applyEntry(sql, id, 'DEBIT', '30.00');
    const before = await divergenceCount();
    await corrupt((tx) => tx`UPDATE wallets SET balance = balance + 5 WHERE id = ${id}`);

    const res = await api.request('POST', `/wallets/${id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: brl('75.00'),
      calculatedBalance: brl('70.00'),
      difference: brl('5.00'),
      consistent: false,
      checkedEntries: 2,
      issues: ['BALANCE_MISMATCH', 'LAST_ENTRY_MISMATCH'],
    });
    expect(await divergenceCount()).toBe(before + 1);
    const [wallet] = await sql`SELECT balance FROM wallets WHERE id = ${id}`;
    expect(wallet.balance).toBe('75.00');

    await corrupt((tx) => tx`UPDATE wallets SET balance = balance - 5 WHERE id = ${id}`);
  });

  test('a ledger entry without the matching balance change is flagged', async () => {
    const { id } = await openWallet('100.00');
    const transactionId = Bun.randomUUIDv7();
    await corrupt(async (tx) => {
      await tx`
        INSERT INTO wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, processed_at, created_at, updated_at)
        SELECT ${transactionId}, 'provider-test', ${transactionId}, ${transactionId}, repeat('a', 64), id, player_id,
               'round-1', 'game-1', 'WIN', 10, currency, 'PROCESSED', now(), now(), now()
          FROM wallets WHERE id = ${id}`;
      await tx`
        INSERT INTO wallet_ledger_entries
          (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
        VALUES (${Bun.randomUUIDv7()}, ${id}, ${transactionId}, 2, 'CREDIT', 10, 'BRL', 100, 110, now())`;
    });

    const res = await api.request('POST', `/wallets/${id}/reconciliation`);
    expect(res.body).toMatchObject({
      storedBalance: brl('100.00'),
      calculatedBalance: brl('110.00'),
      difference: brl('-10.00'),
      consistent: false,
      checkedEntries: 2,
      issues: ['BALANCE_MISMATCH', 'LAST_ENTRY_MISMATCH', 'VERSION_MISMATCH'],
    });

    await corrupt(async (tx) => {
      await tx`DELETE FROM wallet_ledger_entries WHERE transaction_id = ${transactionId}`;
      await tx`DELETE FROM wager_transactions WHERE id = ${transactionId}`;
    });
  });

  test('a broken ledger chain is flagged', async () => {
    const { id } = await openWallet('100.00');
    await applyEntry(sql, id, 'DEBIT', '10.00');
    await corrupt(
      (tx) =>
        tx`UPDATE wallet_ledger_entries SET balance_before = 95, balance_after = 85 WHERE wallet_id = ${id} AND wallet_version = 2`,
    );
    await corrupt((tx) => tx`UPDATE wallets SET balance = 85 WHERE id = ${id}`);

    const res = await api.request('POST', `/wallets/${id}/reconciliation`);
    expect(res.body).toMatchObject({
      consistent: false,
      issues: ['BALANCE_MISMATCH', 'LEDGER_CHAIN_BROKEN'],
    });

    await corrupt(async (tx) => {
      await tx`UPDATE wallet_ledger_entries SET balance_before = 100, balance_after = 90 WHERE wallet_id = ${id} AND wallet_version = 2`;
      await tx`UPDATE wallets SET balance = 90 WHERE id = ${id}`;
    });
  });

  test('unknown wallet is 404', async () => {
    const res = await api.request('POST', `/wallets/${Bun.randomUUIDv7()}/reconciliation`);
    expect(res.status).toBe(404);
  });
});
