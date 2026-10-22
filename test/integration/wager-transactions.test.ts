import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { startTestApp, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistent } from '../support/ledger';

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

interface WalletRef {
  id: string;
  playerId: string;
}

type Payload = Record<string, unknown>;

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(amount = '100.00'): Promise<WalletRef> {
  const res = await api.request('POST', '/wallets', {
    playerId: Bun.randomUUIDv7(),
    initialBalance: brl(amount),
  });
  expect(res.status).toBe(201);
  return res.body;
}

function payload(wallet: WalletRef, overrides: Payload = {}): Payload {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('10.00'),
    ...overrides,
  };
}

function submit(body: Payload, key = `${body.providerId}:${body.externalTransactionId}`, headers = {}) {
  return api.request('POST', '/wagering/transactions', body, { 'idempotency-key': key, ...headers });
}

async function processed(wallet: WalletRef, overrides: Payload = {}): Promise<Payload> {
  const body = payload(wallet, overrides);
  const res = await submit(body);
  expect(res.body.status).toBe('PROCESSED');
  return body;
}

async function balanceOf(wallet: WalletRef): Promise<{ balance: string; version: number }> {
  const [row] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
  return row;
}

async function eventTypes(transactionId: string): Promise<string[]> {
  const rows = await sql`
    SELECT event_type FROM outbox_messages
     WHERE aggregate_id = ${transactionId} OR payload->'data'->>'transactionId' = ${transactionId}
     ORDER BY seq`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

async function ledgerCount(transactionId: string): Promise<number> {
  const [row] =
    await sql`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id = ${transactionId}`;
  return row.n;
}

describe('BET / WIN / LOSS', () => {
  test('BET debits, writes one DEBIT entry and emits Processed + BalanceChanged', async () => {
    const wallet = await openWallet('100.00');
    const res = await submit(payload(wallet, { money: brl('25.00') }), undefined, {
      'x-correlation-id': 'corr-bet',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      failureCode: null,
      balance: brl('75.00'),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet)).toEqual({ balance: '75.00', version: 2 });
    const [entry] = await sql`
      SELECT direction, amount, balance_before, balance_after, wallet_version
        FROM wallet_ledger_entries WHERE transaction_id = ${res.body.transactionId}`;
    expect(entry).toEqual({
      direction: 'DEBIT',
      amount: '25.00',
      balance_before: '100.00',
      balance_after: '75.00',
      wallet_version: 2,
    });
    expect(await eventTypes(res.body.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const [event] = await sql`
      SELECT partition_key, payload FROM outbox_messages
       WHERE aggregate_id = ${res.body.transactionId} AND event_type = 'WagerTransactionProcessed'`;
    expect(event.partition_key).toBe(wallet.id);
    expect(event.payload).toMatchObject({
      correlationId: 'corr-bet',
      data: { kind: 'BET', balanceAfter: brl('75.00') },
    });
  });

  test('BET without funds is REJECTED INSUFFICIENT_FUNDS: persisted, no entry, balance untouched', async () => {
    const wallet = await openWallet('10.00');
    const res = await submit(payload(wallet, { money: brl('10.01') }));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
    });
    expect(await ledgerCount(res.body.transactionId)).toBe(0);
    expect(await balanceOf(wallet)).toEqual({ balance: '10.00', version: 1 });
    expect(await eventTypes(res.body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test('WIN credits, with or without a BET reference', async () => {
    const wallet = await openWallet('100.00');
    const bet = await processed(wallet, { money: brl('10.00') });
    const linked = await submit(
      payload(wallet, {
        kind: 'WIN',
        money: brl('30.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const loose = await submit(payload(wallet, { kind: 'WIN', money: brl('5.00') }));

    expect(linked.body).toMatchObject({ status: 'PROCESSED', balance: brl('120.00') });
    expect(loose.body).toMatchObject({ status: 'PROCESSED', balance: brl('125.00') });
    const [row] =
      await sql`SELECT reference_transaction_id FROM wager_transactions WHERE id = ${linked.body.transactionId}`;
    expect(row.reference_transaction_id).not.toBeNull();
  });

  test('LOSS records the result without moving balance or emitting BalanceChanged', async () => {
    const wallet = await openWallet('100.00');
    const res = await submit(payload(wallet, { kind: 'LOSS', money: brl('0.00') }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(await ledgerCount(res.body.transactionId)).toBe(0);
    expect(await balanceOf(wallet)).toEqual({ balance: '100.00', version: 1 });
    expect(await eventTypes(res.body.transactionId)).toEqual(['WagerTransactionProcessed']);
  });

  test('currency and player mismatches are persisted as auditable rejections', async () => {
    const wallet = await openWallet('100.00');
    const currency = await submit(payload(wallet, { money: { amount: '10.00', currency: 'USD' } }));
    const player = await submit(payload(wallet, { playerId: Bun.randomUUIDv7() }));

    expect(currency.status).toBe(422);
    expect(currency.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      balance: brl('100.00'),
    });
    expect(player.body).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    const [row] = await sql`
      SELECT currency, result_balance, result_currency FROM wager_transactions WHERE id = ${currency.body.transactionId}`;
    expect(row).toEqual({ currency: 'USD', result_balance: '100.00', result_currency: 'BRL' });
  });
});

describe('REFUND / ROLLBACK', () => {
  test('REFUND credits the BET back once; any second reversal is REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await openWallet('100.00');
    const bet = await processed(wallet, { money: brl('40.00') });
    const reversal = (kind: string) =>
      submit(
        payload(wallet, {
          kind,
          money: brl('40.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );

    const refund = await reversal('REFUND');
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    for (const kind of ['REFUND', 'ROLLBACK']) {
      const again = await reversal(kind);
      expect(again.status).toBe(422);
      expect(again.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    }
    const win = await submit(
      payload(wallet, { kind: 'WIN', referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(wallet)).toEqual({ balance: '100.00', version: 3 });
  });

  test('ROLLBACK inverts its reference: BET → credit, WIN → debit, REFUND → debit', async () => {
    const wallet = await openWallet('100.00');
    const bet = await processed(wallet, { money: brl('10.00') });
    const win = await processed(wallet, { kind: 'WIN', money: brl('20.00') });
    const bet2 = await processed(wallet, { money: brl('5.00') });
    const refund = await processed(wallet, {
      kind: 'REFUND',
      money: brl('5.00'),
      referenceExternalTransactionId: bet2.externalTransactionId,
    });
    expect(await balanceOf(wallet)).toEqual({ balance: '110.00', version: 5 });

    const rollback = (ref: Payload, amount: string) =>
      submit(
        payload(wallet, {
          kind: 'ROLLBACK',
          money: brl(amount),
          referenceExternalTransactionId: ref.externalTransactionId,
        }),
      );
    expect((await rollback(bet, '10.00')).body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('120.00'),
    });
    expect((await rollback(win, '20.00')).body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
    });
    expect((await rollback(refund, '5.00')).body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('95.00'),
    });
  });

  test('a reversal that would make the balance negative is INSUFFICIENT_FUNDS_FOR_REVERSAL', async () => {
    const wallet = await openWallet('0.00');
    const win = await processed(wallet, { kind: 'WIN', money: brl('50.00') });
    await processed(wallet, { money: brl('45.00') });

    const res = await submit(
      payload(wallet, {
        kind: 'ROLLBACK',
        money: brl('50.00'),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS_FOR_REVERSAL', balance: brl('5.00') });
  });

  test.each<[string, (ref: Payload) => Payload, string]>([
    ['REFUND of a WIN', () => ({ kind: 'REFUND' }), 'REFERENCE_KIND_NOT_ALLOWED'],
    [
      'amount different from the reference',
      () => ({ kind: 'ROLLBACK', money: brl('19.99') }),
      'REFERENCE_AMOUNT_MISMATCH',
    ],
    ['reference from another round', () => ({ kind: 'ROLLBACK', roundId: 'round-2' }), 'REFERENCE_MISMATCH'],
  ])('%s is rejected', async (_name, overrides, failureCode) => {
    const wallet = await openWallet('100.00');
    const win = await processed(wallet, { kind: 'WIN', money: brl('20.00') });
    const res = await submit(
      payload(wallet, {
        money: brl('20.00'),
        referenceExternalTransactionId: win.externalTransactionId,
        ...overrides(win),
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode });
  });

  test('a REJECTED reference cannot be reversed', async () => {
    const wallet = await openWallet('1.00');
    const bet = payload(wallet, { money: brl('5.00') });
    expect((await submit(bet)).body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const res = await submit(
      payload(wallet, {
        kind: 'REFUND',
        money: brl('5.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
  });

  test('a reference from another wallet is a mismatch', async () => {
    const wallet = await openWallet('100.00');
    const other = await openWallet('100.00');
    const bet = await processed(other, { money: brl('10.00') });
    const res = await submit(
      payload(wallet, {
        kind: 'REFUND',
        money: brl('10.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(res.body.failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('a reversal arriving before its reference is accepted as PENDING_REFERENCE and woken up by the BET', async () => {
    const wallet = await openWallet('100.00');
    const betId = `tx-${Bun.randomUUIDv7()}`;
    const refund = await submit(
      payload(wallet, { kind: 'REFUND', money: brl('10.00'), referenceExternalTransactionId: betId }),
    );

    expect(refund.status).toBe(202);
    expect(refund.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      failureCode: null,
      balance: brl('100.00'),
    });
    expect(await eventTypes(refund.body.transactionId)).toEqual(['WagerTransactionPendingReference']);
    const [scheduled] = await sql`
      SELECT next_reference_check_at FROM wager_transactions WHERE id = ${refund.body.transactionId}`;

    await processed(wallet, { externalTransactionId: betId, money: brl('10.00') });
    const [woken] = await sql`
      SELECT status, next_reference_check_at FROM wager_transactions WHERE id = ${refund.body.transactionId}`;
    expect(woken.status).toBe('PENDING_REFERENCE');
    expect(woken.next_reference_check_at.getTime()).toBeLessThan(scheduled.next_reference_check_at.getTime());
  });
});

describe('idempotency', () => {
  test('replaying the same request returns the original result, including the balance observed then', async () => {
    const wallet = await openWallet('100.00');
    const bet = payload(wallet, { money: brl('30.00') });
    const first = await submit(bet);
    await processed(wallet, { money: brl('5.00') });

    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('70.00'));
    expect(await balanceOf(wallet)).toEqual({ balance: '65.00', version: 3 });
    expect(await ledgerCount(first.body.transactionId)).toBe(1);
  });

  test('a replayed rejection keeps its 422 and writes nothing new', async () => {
    const wallet = await openWallet('1.00');
    const bet = payload(wallet, { money: brl('2.00') });
    const first = await submit(bet);
    const [before] = await sql`SELECT count(*)::int AS n FROM outbox_messages`;
    const replay = await submit(bet);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    const [after] = await sql`SELECT count(*)::int AS n FROM outbox_messages`;
    expect(after.n).toBe(before.n);
  });

  test('the amount is normalized before hashing: "10" and "10.00" are the same payload', async () => {
    const wallet = await openWallet('100.00');
    const bet = payload(wallet, { money: brl('10') });
    await submit(bet);
    const replay = await submit({ ...bet, money: brl('10.00') });
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('same key with a different payload is IDEMPOTENCY_KEY_REUSED and changes nothing', async () => {
    const wallet = await openWallet('100.00');
    const bet = payload(wallet, { money: brl('10.00') });
    await submit(bet);
    const res = await submit({ ...bet, money: brl('11.00') });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', retryable: false });
    expect(await balanceOf(wallet)).toEqual({ balance: '90.00', version: 2 });
  });

  test('a new key for an existing (provider, externalTransactionId) is EXTERNAL_TRANSACTION_ID_REUSED', async () => {
    const wallet = await openWallet('100.00');
    const bet = await processed(wallet);
    const res = await submit(bet, 'another-key');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_ID_REUSED');
  });
});

describe('input validation', () => {
  test('missing Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const wallet = await openWallet();
    const res = await api.request('POST', '/wagering/transactions', payload(wallet));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test.each<[string, Payload, string]>([
    ['OPENING submitted by a provider', { kind: 'OPENING' }, 'KIND_NOT_ALLOWED'],
    ['unknown kind', { kind: 'BONUS' }, 'VALIDATION_ERROR'],
    ['REFUND without reference', { kind: 'REFUND' }, 'VALIDATION_ERROR'],
    ['reserved internal provider', { providerId: 'internal' }, 'VALIDATION_ERROR'],
    ['BET of zero', { money: brl('0.00') }, 'INVALID_MONEY'],
    ['three decimals', { money: brl('1.001') }, 'INVALID_MONEY'],
    ['missing roundId', { roundId: undefined }, 'VALIDATION_ERROR'],
    ['malformed walletId', { walletId: 'w-1' }, 'VALIDATION_ERROR'],
  ])('%s is 400 %s', async (_name, overrides, code) => {
    const wallet = await openWallet();
    const res = await submit(payload(wallet, overrides), 'key-validation');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code, retryable: false });
  });

  test('an unknown wallet is 422 WALLET_NOT_FOUND and nothing is persisted', async () => {
    const body = payload({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() });
    const res = await submit(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    const [row] =
      await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${body.externalTransactionId}`;
    expect(row.n).toBe(0);
  });
});

describe('queries', () => {
  test('a transaction is readable by id and by (provider, externalTransactionId)', async () => {
    const wallet = await openWallet('100.00');
    const bet = payload(wallet, { money: brl('12.34') });
    const { body } = await submit(bet);

    const byId = await api.request('GET', `/wagering/transactions/${body.transactionId}`);
    const byExternal = await api.request(
      'GET',
      `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: body.transactionId,
      walletId: wallet.id,
      kind: 'BET',
      money: brl('12.34'),
      status: 'PROCESSED',
      balance: brl('87.66'),
      referenceTransactionId: null,
    });
    expect(byExternal.body).toEqual(byId.body);
  });

  test('unknown transactions are 404 TRANSACTION_NOT_FOUND', async () => {
    const byId = await api.request('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`);
    const byExternal = await api.request('GET', '/providers/provider-a/wagering/transactions/missing');
    expect(byId.status).toBe(404);
    expect(byId.body.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect(byExternal.status).toBe(404);
  });
});
