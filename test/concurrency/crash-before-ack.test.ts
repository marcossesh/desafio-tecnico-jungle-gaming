// Instância morre depois do commit e antes do ack: a mensagem volta e outra instância não repete o efeito.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { clusterEnv, type Instance, spawnInstance } from '../support/instance';
import { assertLedgerConsistent } from '../support/ledger';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { waitFor } from '../support/wait';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

let db: TestDatabase;
let sql: SQL;
let queues: TestQueues;
const started: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  queues = await createTestQueues({ visibilityTimeoutSeconds: 2 });
});

afterAll(async () => {
  await Promise.all(started.map((instance) => instance.kill('SIGTERM')));
  await assertLedgerConsistent(sql);
  await queues.destroy();
  await db.drop();
});

test('a worker killed after commit and before ack does not duplicate the debit on redelivery', async () => {
  const env = clusterEnv(db.url, queues.env);
  const doomed = await spawnInstance({ ...env, FAILPOINTS: 'consumer.afterCommitBeforeAck' });
  started.push(doomed);

  const res = await fetch(`${doomed.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });
  const wallet = (await res.json()) as { id: string; playerId: string };
  const message = wagerMessage(wallet, { money: { amount: '10.00', currency: 'BRL' } });
  await queues.send(message, wallet.id);

  expect(await doomed.process.exited).toBe(137);
  const [committed] = await sql`
    SELECT (SELECT status FROM wager_transactions WHERE external_transaction_id = ${message.data.externalTransactionId}) AS status,
           (SELECT count(*)::int FROM inbox_messages WHERE message_id = ${message.messageId}) AS inbox,
           (SELECT balance FROM wallets WHERE id = ${wallet.id}) AS balance`;
  expect(committed).toEqual({ status: 'PROCESSED', inbox: 1, balance: '90.00' });
  expect(await queues.inputDepth()).toBe(1); // sem ack: volta após o visibility timeout

  const survivor = await spawnInstance(env);
  started.push(survivor);
  await waitFor(async () => (await queues.inputDepth()) === 0, {
    timeoutMs: 15_000,
    message: 'redelivery acked',
  });

  const [after] = await sql`
    SELECT (SELECT balance FROM wallets WHERE id = ${wallet.id}) AS balance,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id} AND direction = 'DEBIT') AS debits,
           (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind = 'BET') AS bets`;
  expect(after).toEqual({ balance: '90.00', debits: 1, bets: 1 });
  const outcomes = survivor.logs('wager message processed').map((log) => log.outcome);
  expect(outcomes).toEqual(['duplicate_message']);
}, 60_000);
