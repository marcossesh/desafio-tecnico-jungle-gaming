// Falha injetada depois de todas as escritas e antes do commit: nada pode sobrar (tx, ledger, saldo, inbox, outbox).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { Money } from '../../src/shared/money/money';
import type { WagerCommand } from '../../src/wagering/application/process-wager-transaction';
import type { Wallet } from '../../src/wallet/domain/wallet';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { failure } from '../support/failure';
import { assertLedgerConsistent } from '../support/ledger';
import { betCommand, createUseCases, type UseCases } from '../support/wagering';

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

async function snapshot(wallet: Wallet) {
  const [row] = await sql`
    SELECT (SELECT balance FROM wallets WHERE id = ${wallet.id}) AS balance,
           (SELECT version FROM wallets WHERE id = ${wallet.id}) AS version,
           (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${wallet.id}) AS transactions,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}) AS entries,
           (SELECT count(*)::int FROM outbox_messages WHERE partition_key = ${wallet.id}) AS events,
           (SELECT count(*)::int FROM inbox_messages WHERE message_id LIKE ${`${wallet.id}%`}) AS inbox`;
  return row;
}

describe('process.beforeCommit failpoint', () => {
  test.each<[string, (wallet: Wallet) => WagerCommand, string]>([
    ['processed BET', (wallet) => betCommand(wallet, { money: brl('30.00') }), 'PROCESSED'],
    ['rejected BET', (wallet) => betCommand(wallet, { money: brl('500.00') }), 'REJECTED'],
    [
      'pending REFUND',
      (wallet) => betCommand(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }),
      'PENDING_REFERENCE',
    ],
  ])('%s leaves no trace when the commit never happens', async (_name, command, status) => {
    const wallet = await useCases.openWallet('100.00');
    const cmd = command(wallet);
    const ctx = {
      channel: 'sqs' as const,
      correlationId: 'corr-atomicity',
      inbox: { consumerName: 'wager-consumer', messageId: `${wallet.id}:msg-1` },
    };
    const before = await snapshot(wallet);

    const error = await failure(
      useCases.processWager(['process.beforeCommit']).execute(cmd, `key-${wallet.id}`, ctx),
    );
    expect(error).toMatchObject({ name: 'FailpointError' });
    expect(await snapshot(wallet)).toEqual(before);

    // a mesma mensagem, reentregue depois, é processada uma única vez
    const outcome = await useCases.processWager().execute(cmd, `key-${wallet.id}`, ctx);
    if (outcome.type !== 'new') throw new Error(`unexpected outcome ${outcome.type}`);
    expect(String(outcome.transaction.status)).toBe(status);
    const after = await snapshot(wallet);
    expect(after.transactions).toBe(before.transactions + 1);
    expect(after.inbox).toBe(1);
    expect(after.events).toBeGreaterThan(before.events);
  });
});
