// Consumidor contra MiniStack real: ack só após commit, inbox, DLQ explícita, backoff e shutdown.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import { createLogger } from '../../src/shared/infra/logger';
import { createSqsClient, ensureQueues, type QueueNames, type QueueUrls } from '../../src/shared/infra/sqs';
import type { ProcessWagerTransaction } from '../../src/wagering/application/process-wager-transaction';
import { SqsConsumer } from '../../src/wagering/infra/sqs-consumer';
import type { Wallet } from '../../src/wallet/domain/wallet';
import { startTestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistent } from '../support/ledger';
import { createUseCases, type UseCases } from '../support/wagering';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

const MAX_ATTEMPTS = 3;

let db: TestDatabase;
let sql: SQL;
let useCases: UseCases;
let sqs: SQSClient;
let names: QueueNames;
let queues: QueueUrls;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  useCases = await createUseCases(db.url);
  sqs = createSqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: 'us-east-1',
  });
  const suffix = Bun.randomUUIDv7().slice(-8);
  names = { input: `c-${suffix}-in.fifo`, dlq: `c-${suffix}-dlq.fifo`, events: `c-${suffix}-ev.fifo` };
  queues = await ensureQueues(sqs, names, { maxAttempts: MAX_ATTEMPTS, visibilityTimeoutSeconds: 30 });
});

afterAll(async () => {
  await assertLedgerConsistent(sql);
  for (const url of Object.values(queues)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  sqs.destroy();
  await useCases.close();
  await db.drop();
});

function consumer(processWager: ProcessWagerTransaction = useCases.processWager()): SqsConsumer {
  return new SqsConsumer(sqs, processWager, createLogger('silent'), {
    consumerName: 'wager-consumer',
    queues,
    maxAttempts: MAX_ATTEMPTS,
    retryBaseSeconds: 1,
    waitTimeSeconds: 1,
    maxMessages: 10,
    shutdownGraceMs: 5_000,
  });
}

function envelope(
  wallet: Wallet,
  data: Record<string, unknown> = {},
  messageId = `msg-${Bun.randomUUIDv7()}`,
) {
  const externalTransactionId = `tx-${Bun.randomUUIDv7()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...data,
    },
  };
}

// Dedup id explícito e único: o teste controla quando o SQS entrega "a mesma" mensagem duas vezes.
async function send(body: unknown, group: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.input,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

async function drain(worker: SqsConsumer): Promise<void> {
  while ((await worker.runOnce()) > 0) {}
}

async function inputDepth(): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queues.input,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible)
  );
}

async function receiveRaw(url: string, wait = 1): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: wait,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return res.Messages ?? [];
}

async function takeDeadLetters(): Promise<Message[]> {
  const messages = await receiveRaw(queues.dlq);
  for (const m of messages) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: m.ReceiptHandle }));
  }
  return messages;
}

async function walletState(wallet: Wallet) {
  const [row] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
  return row;
}

function holdWalletLock(wallet: Wallet) {
  let release = () => {};
  let ready = () => {};
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = sql.begin(async (tx) => {
    await tx`SELECT 1 FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  return {
    acquired,
    async release() {
      release();
      await done;
    },
  };
}

describe('SqsConsumer', () => {
  test('a valid message is applied once and acked after commit', async () => {
    const wallet = await useCases.openWallet('100.00');
    await send(envelope(wallet, { money: { amount: '30.00', currency: 'BRL' } }), wallet.id);

    await drain(consumer());

    expect(await walletState(wallet)).toEqual({ balance: '70.00', version: 2 });
    expect(await inputDepth()).toBe(0);
  });

  test('the same messageId delivered twice has a single effect (inbox)', async () => {
    const wallet = await useCases.openWallet('100.00');
    const message = envelope(wallet);
    await send(message, wallet.id);
    await send(message, wallet.id);

    await drain(consumer());

    expect(await walletState(wallet)).toEqual({ balance: '90.00', version: 2 });
    const [inbox] =
      await sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${message.messageId}`;
    expect(inbox.n).toBe(1);
    expect(await inputDepth()).toBe(0);
  });

  test('the same operation under a new messageId is an idempotent replay', async () => {
    const wallet = await useCases.openWallet('100.00');
    const first = envelope(wallet);
    await send(first, wallet.id);
    await send({ ...first, messageId: `msg-${Bun.randomUUIDv7()}` }, wallet.id);

    await drain(consumer());

    expect(await walletState(wallet)).toEqual({ balance: '90.00', version: 2 });
    expect(await inputDepth()).toBe(0);
  });

  test('business outcomes (REJECTED, PENDING_REFERENCE) are acked', async () => {
    const wallet = await useCases.openWallet('5.00');
    await send(envelope(wallet, { money: { amount: '10.00', currency: 'BRL' } }), wallet.id);
    await send(envelope(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }), wallet.id);

    await drain(consumer());

    const statuses = await sql`
        SELECT status FROM wager_transactions
         WHERE wallet_id = ${wallet.id} AND kind <> 'OPENING' ORDER BY created_at`;
    expect(statuses.map((r: { status: string }) => r.status)).toEqual(['REJECTED', 'PENDING_REFERENCE']);
    expect(await inputDepth()).toBe(0);
    expect(await takeDeadLetters()).toEqual([]);
  });

  test('messages of a wallet are applied in order within a batch', async () => {
    const wallet = await useCases.openWallet('100.00');
    const bet = envelope(wallet, { money: { amount: '40.00', currency: 'BRL' } });
    const refund = envelope(wallet, {
      kind: 'REFUND',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    await send(bet, wallet.id);
    await send(refund, wallet.id);

    await drain(consumer());

    const [row] = await sql`
      SELECT status FROM wager_transactions WHERE external_transaction_id = ${refund.data.externalTransactionId}`;
    expect(row.status).toBe('PROCESSED');
    expect(await walletState(wallet)).toEqual({ balance: '100.00', version: 3 });
  });

  test.each<[string, (wallet: Wallet) => unknown, string]>([
    ['non-JSON body', () => 'not json', 'VALIDATION_ERROR'],
    ['wrong message type', (w) => ({ ...envelope(w), type: 'Other' }), 'VALIDATION_ERROR'],
    ['invalid money', (w) => envelope(w, { money: { amount: '1.001', currency: 'BRL' } }), 'INVALID_MONEY'],
    ['OPENING kind', (w) => envelope(w, { kind: 'OPENING' }), 'KIND_NOT_ALLOWED'],
    ['unknown wallet', (w) => envelope(w, { walletId: Bun.randomUUIDv7() }), 'WALLET_NOT_FOUND'],
  ])('%s goes straight to the DLQ with its failureCode', async (_name, body, failureCode) => {
    const wallet = await useCases.openWallet('100.00');
    await send(body(wallet), wallet.id);

    await drain(consumer());

    expect(await inputDepth()).toBe(0);
    const [dead, ...rest] = await takeDeadLetters();
    expect(rest).toEqual([]);
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe(failureCode);
    expect(dead?.MessageAttributes?.receiveCount?.StringValue).toBe('1');
    expect(await walletState(wallet)).toEqual({ balance: '100.00', version: 1 });
  });

  test('an idempotency conflict is permanent and keeps the original effect', async () => {
    const wallet = await useCases.openWallet('100.00');
    const original = envelope(wallet);
    await send(original, wallet.id);
    await send(
      envelope(wallet, {
        idempotencyKey: original.data.idempotencyKey,
        money: { amount: '99.00', currency: 'BRL' },
      }),
      wallet.id,
    );

    await drain(consumer());

    const [dead] = await takeDeadLetters();
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await walletState(wallet)).toEqual({ balance: '90.00', version: 2 });
  });

  test('a transient failure is retried after a visibility backoff and then succeeds', async () => {
    const wallet = await useCases.openWallet('100.00');
    const lock = holdWalletLock(wallet);
    await lock.acquired;
    const worker = consumer(useCases.processWager([], { lockTimeoutMs: 100, maxAttempts: 1 }));
    await send(envelope(wallet), wallet.id);

    expect(await worker.runOnce()).toBe(1);
    expect(await receiveRaw(queues.input, 0)).toEqual([]); // invisível durante o backoff
    await lock.release();

    await Bun.sleep(1_200);
    await drain(worker);
    expect(await walletState(wallet)).toEqual({ balance: '90.00', version: 2 });
    expect(await inputDepth()).toBe(0);
  });

  test('a persistent transient failure goes to the DLQ after SQS_MAX_ATTEMPTS receives', async () => {
    const wallet = await useCases.openWallet('100.00');
    const lock = holdWalletLock(wallet);
    await lock.acquired;
    const worker = consumer(useCases.processWager([], { lockTimeoutMs: 100, maxAttempts: 1 }));
    await send(envelope(wallet), wallet.id);

    try {
      for (let receive = 1; receive <= MAX_ATTEMPTS; receive++) {
        let handled = 0;
        for (let i = 0; i < 10 && handled === 0; i++) handled = await worker.runOnce();
        expect(handled).toBe(1);
      }
    } finally {
      await lock.release();
    }

    const [dead] = await takeDeadLetters();
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('LOCK_TIMEOUT');
    expect(dead?.MessageAttributes?.receiveCount?.StringValue).toBe(String(MAX_ATTEMPTS));
    expect(await inputDepth()).toBe(0);
    expect(await walletState(wallet)).toEqual({ balance: '100.00', version: 1 });
  });

  test('stop finishes the message in progress and returns the unstarted ones to the queue', async () => {
    const wallet = await useCases.openWallet('100.00');
    const lock = holdWalletLock(wallet);
    await lock.acquired;
    const first = envelope(wallet);
    const second = envelope(wallet);
    await send(first, wallet.id);
    await send(second, wallet.id);

    const worker = consumer();
    worker.start();
    await Bun.sleep(500); // primeira mensagem bloqueada no lock da wallet
    const stopping = worker.stop();
    await Bun.sleep(100);
    await lock.release();
    await stopping;

    const [first_] = await sql`
      SELECT status FROM wager_transactions WHERE external_transaction_id = ${first.data.externalTransactionId}`;
    expect(first_?.status).toBe('PROCESSED');
    const returned = await receiveRaw(queues.input, 0);
    expect(returned.map((m) => JSON.parse(m.Body ?? '{}').messageId)).toEqual([second.messageId]);
    expect(returned[0]?.Attributes?.ApproximateReceiveCount).toBe('2');
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queues.input,
        ReceiptHandle: returned[0]?.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );

    await drain(consumer());
    expect(await walletState(wallet)).toEqual({ balance: '80.00', version: 3 });
  });

  test('the consumer role wires the queues by name and shuts down without waiting for the long poll', async () => {
    const api = await startTestApp(db.url, {
      ROLES: 'api,consumer',
      SQS_INPUT_QUEUE: names.input,
      SQS_DLQ_QUEUE: names.dlq,
      SQS_EVENTS_QUEUE: names.events,
    });
    const wallet = await useCases.openWallet('100.00');
    await send(envelope(wallet), wallet.id);

    let balance = '100.00';
    for (let i = 0; i < 50 && balance === '100.00'; i++) {
      await Bun.sleep(100);
      balance = (await api.request('GET', `/wallets/${wallet.id}`)).body.balance.amount;
    }
    expect(balance).toBe('90.00');

    const startedAt = performance.now();
    await api.close();
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });
});
