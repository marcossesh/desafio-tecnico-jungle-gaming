// Deduplicação por inbox no use case (o consumidor SQS só repassa consumerName + messageId do corpo).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { Money } from '../../src/shared/money/money';
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

const sqs = (messageId: string) => ({
  channel: 'sqs' as const,
  correlationId: 'corr-inbox',
  causationId: messageId,
  inbox: { consumerName: 'wager-consumer', messageId },
});

describe('inbox', () => {
  test('a redelivered message is a duplicate and has no effect', async () => {
    const wallet = await useCases.openWallet('100.00');
    const command = betCommand(wallet);
    const process = useCases.processWager();

    expect((await process.execute(command, 'k-1', sqs('msg-a'))).type).toBe('new');
    expect(await process.execute(command, 'k-1', sqs('msg-a'))).toEqual({ type: 'duplicate_message' });

    const [row] = await sql`SELECT balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe('90.00');
  });

  test('the same business operation under a new messageId is an idempotent replay', async () => {
    const wallet = await useCases.openWallet('100.00');
    const command = betCommand(wallet);
    const process = useCases.processWager();

    const first = await process.execute(command, 'k-2', sqs('msg-b1'));
    const second = await process.execute(command, 'k-2', sqs('msg-b2'));
    if (first.type !== 'new' || second.type !== 'replay') throw new Error('unexpected outcomes');
    expect(second.transaction.id).toBe(first.transaction.id);
    const [row] =
      await sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id IN ('msg-b1', 'msg-b2')`;
    expect(row.n).toBe(2);
  });

  test('a messageId reused with another payload is a permanent INBOX_PAYLOAD_MISMATCH', async () => {
    const wallet = await useCases.openWallet('100.00');
    const process = useCases.processWager();
    await process.execute(betCommand(wallet), 'k-3', sqs('msg-c'));

    const error = await failure(
      process.execute(
        betCommand(wallet, { money: Money.from({ amount: '1.00', currency: 'BRL' }) }),
        'k-4',
        sqs('msg-c'),
      ),
    );
    expect(error).toMatchObject({ code: 'INBOX_PAYLOAD_MISMATCH' });
  });

  test('an unknown wallet rolls the inbox record back, so a later fix can be retried', async () => {
    const wallet = await useCases.openWallet('100.00');
    const command = { ...betCommand(wallet), walletId: Bun.randomUUIDv7() };
    const error = await failure(useCases.processWager().execute(command, 'k-5', sqs('msg-d')));
    expect(error).toMatchObject({ code: 'WALLET_NOT_FOUND' });
    const [row] = await sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = 'msg-d'`;
    expect(row.n).toBe(0);
  });
});
