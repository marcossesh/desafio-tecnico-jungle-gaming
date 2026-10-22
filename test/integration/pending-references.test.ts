// Worker de PENDING_REFERENCE com relógio controlado: backoff, limite de tentativas, wake-up e claim concorrente.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { Money } from '../../src/shared/money/money';
import type { WagerCommand } from '../../src/wagering/application/process-wager-transaction';
import type { Wallet } from '../../src/wallet/domain/wallet';
import { startTestApp } from '../support/app';
import { FakeClock } from '../support/clock';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistent } from '../support/ledger';
import { betCommand, createUseCases, REFERENCE_BACKOFF, type UseCases } from '../support/wagering';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

let db: TestDatabase;
let sql: SQL;
let useCases: UseCases;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  useCases = await createUseCases(db.url);
});

afterAll(async () => {
  await assertLedgerConsistent(sql);
  await useCases.close();
  await db.drop();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const http = { channel: 'http' as const, correlationId: 'corr-pending' };

async function submit(command: WagerCommand) {
  const outcome = await useCases
    .processWager()
    .execute(command, `key-${command.externalTransactionId}`, http);
  if (outcome.type !== 'new') throw new Error(`unexpected ${outcome.type}`);
  return outcome.transaction;
}

async function row(transactionId: string) {
  const [found] = await sql`
    SELECT status, failure_code, reference_attempts, next_reference_check_at, reference_transaction_id, result_balance
      FROM wager_transactions WHERE id = ${transactionId}`;
  return found;
}

async function eventsOf(transactionId: string) {
  return sql`
    SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ${transactionId} ORDER BY seq`;
}

function refundOf(wallet: Wallet, betExternalId: string, amount = '10.00'): WagerCommand {
  return betCommand(wallet, {
    kind: 'REFUND',
    money: brl(amount),
    referenceExternalTransactionId: betExternalId,
  });
}

describe('pending reference worker', () => {
  test('an item that is not due yet is left alone', async () => {
    const wallet = await useCases.openWallet('100.00');
    const pending = await submit(refundOf(wallet, 'bet-not-yet'));
    const before = await row(pending.id);

    await useCases.reprocess(new FakeClock()).runOnce();
    expect(await row(pending.id)).toEqual(before);
  });

  test('a REFUND that arrived before its BET is resolved once the BET is processed', async () => {
    const wallet = await useCases.openWallet('100.00');
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submit(refundOf(wallet, betId));
    const bet = await submit(betCommand(wallet, { externalTransactionId: betId, money: brl('10.00') }));
    expect(String(bet.status)).toBe('PROCESSED');

    const clock = new FakeClock();
    clock.advance(1);
    const report = await useCases.reprocess(clock).runOnce();
    expect(report.processed).toBeGreaterThanOrEqual(1);

    expect(await row(refund.id)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: bet.id,
      next_reference_check_at: null,
      result_balance: '100.00',
    });
    const [wallets] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(wallets).toEqual({ balance: '100.00', version: 3 });
    const events = await eventsOf(refund.id);
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    expect(events[1].payload).toMatchObject({ correlationId: 'corr-pending', causationId: refund.id });
  });

  test('a missing reference is retried with exponential backoff and then REJECTED REFERENCE_NOT_FOUND', async () => {
    const MAX = 4;
    const wallet = await useCases.openWallet('100.00');
    const rollback = await submit(
      betCommand(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: `ghost-${Bun.randomUUIDv7()}` }),
    );
    const clock = new FakeClock();
    const worker = useCases.reprocess(clock, { maxReferenceAttempts: MAX });

    for (let attempts = 1; attempts < MAX; attempts++) {
      const due = (await row(rollback.id)).next_reference_check_at as Date;
      clock.advance(due.getTime() - clock.now().getTime());
      await worker.runOnce();

      const current = await row(rollback.id);
      expect(current).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: attempts });
      const delay = current.next_reference_check_at.getTime() - clock.now().getTime();
      const expected = REFERENCE_BACKOFF.baseMs * 2 ** attempts;
      expect(delay).toBeGreaterThanOrEqual(expected * 0.8);
      expect(delay).toBeLessThanOrEqual(expected * 1.2);
    }

    clock.advance(REFERENCE_BACKOFF.capMs * 2);
    await worker.runOnce();
    expect(await row(rollback.id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      next_reference_check_at: null,
    });
    const types = (await eventsOf(rollback.id)).map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });

  test('unexpected errors consume attempts and end in FAILED PROCESSING_FAILED without touching the wallet', async () => {
    const MAX = 3;
    const wallet = await useCases.openWallet('100.00');
    const pending = await submit(refundOf(wallet, `ghost-${Bun.randomUUIDv7()}`));
    const clock = new FakeClock();
    const worker = useCases.reprocess(clock, {
      maxReferenceAttempts: MAX,
      failpoints: ['reprocess.beforeCommit'],
    });

    for (let i = 0; i < MAX; i++) {
      clock.advance(REFERENCE_BACKOFF.capMs * 2);
      await worker.runOnce();
    }
    expect(await row(pending.id)).toMatchObject({ status: 'FAILED', failure_code: 'PROCESSING_FAILED' });
    const [state] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(state).toEqual({ balance: '100.00', version: 1 });
  });

  test('two workers draining the same backlog process every item exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => useCases.openWallet('100.00')));
    const refunds: string[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 3; i++) {
        const betId = `bet-${Bun.randomUUIDv7()}`;
        refunds.push((await submit(refundOf(wallet, betId, '5.00'))).id);
        await submit(betCommand(wallet, { externalTransactionId: betId, money: brl('5.00') }));
      }
    }

    const other = await createUseCases(db.url);
    try {
      const clock = new FakeClock();
      clock.advance(1);
      const drain = async (worker: ReturnType<UseCases['reprocess']>) => {
        let processed = 0;
        for (let report = await worker.runOnce(); report.claimed > 0; report = await worker.runOnce()) {
          processed += report.processed;
        }
        return processed;
      };
      const [a, b] = await Promise.all([drain(useCases.reprocess(clock)), drain(other.reprocess(clock))]);
      expect(a + b).toBeGreaterThanOrEqual(refunds.length);
    } finally {
      await other.close();
    }

    const results = await sql`
      SELECT t.status,
             (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.transaction_id = t.id) AS entries,
             (SELECT count(*)::int FROM outbox_messages o
               WHERE o.aggregate_id = t.id AND o.event_type = 'WagerTransactionProcessed') AS processed_events
        FROM wager_transactions t WHERE t.id IN ${sql(refunds)}`;
    expect(results).toHaveLength(refunds.length);
    for (const result of results)
      expect(result).toEqual({ status: 'PROCESSED', entries: 1, processed_events: 1 });
    const balances =
      await sql`SELECT DISTINCT balance FROM wallets WHERE id IN ${sql(wallets.map((w) => w.id))}`;
    expect(balances).toEqual([{ balance: '100.00' }]);
  });

  test('the scheduler role resolves pending references in the background', async () => {
    const api = await startTestApp(db.url, { ROLES: 'api,scheduler', PENDING_REF_TICK_MS: '50' });
    try {
      const wallet = await useCases.openWallet('100.00');
      const betId = `bet-${Bun.randomUUIDv7()}`;
      const body = (overrides: Record<string, unknown>) => ({
        providerId: 'provider-a',
        externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        money: { amount: '10.00', currency: 'BRL' },
        ...overrides,
      });
      const refund = await api.request(
        'POST',
        '/wagering/transactions',
        body({ kind: 'REFUND', referenceExternalTransactionId: betId }),
        {
          'idempotency-key': `refund-${betId}`,
        },
      );
      expect(refund.status).toBe(202);
      await api.request(
        'POST',
        '/wagering/transactions',
        body({ kind: 'BET', externalTransactionId: betId }),
        {
          'idempotency-key': betId,
        },
      );

      let status = 'PENDING_REFERENCE';
      for (let i = 0; i < 60 && status === 'PENDING_REFERENCE'; i++) {
        await Bun.sleep(50);
        status = (await api.request('GET', `/wagering/transactions/${refund.body.transactionId}`)).body
          .status;
      }
      expect(status).toBe('PROCESSED');
    } finally {
      await api.close();
    }
  });
});
