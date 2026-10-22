// Publisher da outbox contra MiniStack real: ordem por wallet, concorrência, broker fora do ar e lease expirado.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import type { EventPublisher } from '../../src/messaging/application/ports';
import { PublishOutbox } from '../../src/messaging/application/publish-outbox';
import type { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { SqsEventPublisher } from '../../src/messaging/infra/sqs-event-publisher';
import type { Clock } from '../../src/shared/domain/ports';
import { MikroOrmUnitOfWork } from '../../src/shared/infra/database/mikro-orm-unit-of-work';
import { createLogger } from '../../src/shared/infra/logger';
import { PromMetrics } from '../../src/shared/infra/metrics';
import { createSqsClient, ensureQueues, type QueueNames, type QueueUrls } from '../../src/shared/infra/sqs';
import { systemClock } from '../../src/shared/infra/system';
import { Money } from '../../src/shared/money/money';
import { startTestApp } from '../support/app';
import { FakeClock } from '../support/clock';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistent } from '../support/ledger';
import { betCommand, createUseCases, type UseCases } from '../support/wagering';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

const LEASE_MS = 2_000;
const BACKOFF = { baseMs: 1_000, capMs: 300_000 };

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
  names = { input: `o-${suffix}-in.fifo`, dlq: `o-${suffix}-dlq.fifo`, events: `o-${suffix}-ev.fifo` };
  queues = await ensureQueues(sqs, names, { maxAttempts: 3 });
});

afterAll(async () => {
  await assertLedgerConsistent(sql);
  for (const url of Object.values(queues)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  sqs.destroy();
  await useCases.close();
  await db.drop();
});

class CountingPublisher implements EventPublisher {
  sent: string[] = [];
  constructor(private readonly inner: EventPublisher) {}
  publish(messages: readonly OutboxMessage[]) {
    this.sent.push(...messages.map((m) => m.id));
    return this.inner.publish(messages);
  }
}

function publisherWith(
  options: { clock?: Clock; publisher?: EventPublisher; metrics?: PromMetrics; batchSize?: number } = {},
) {
  return new PublishOutbox(
    new MikroOrmUnitOfWork(useCases.orm),
    options.publisher ?? new SqsEventPublisher(sqs, queues.events),
    options.clock ?? systemClock,
    options.metrics ?? new PromMetrics(),
    createLogger('silent'),
    { batchSize: options.batchSize ?? 50, leaseMs: LEASE_MS, backoff: BACKOFF },
  );
}

async function drainEvents(): Promise<Message[]> {
  const received: Message[] = [];
  for (let empty = 0; empty < 2; ) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.events,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    received.push(...Messages);
    empty = Messages.length === 0 ? empty + 1 : 0;
    // em FIFO, mensagem em voo bloqueia o resto do grupo: consumir de verdade
    if (Messages.length > 0) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queues.events,
          Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
        }),
      );
    }
  }
  return received;
}

async function publishAll(publisher: PublishOutbox): Promise<void> {
  while ((await publisher.runOnce()).claimed > 0) {}
}

async function unpublishedCount(): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
  return row.n;
}

async function walletWithBets(bets: number) {
  const wallet = await useCases.openWallet('100.00');
  for (let i = 0; i < bets; i++) {
    await useCases
      .processWager()
      .execute(
        betCommand(wallet, { money: Money.from({ amount: '1.00', currency: 'BRL' }) }),
        `k-${Bun.randomUUIDv7()}`,
        {
          channel: 'http',
          correlationId: `corr-${i}`,
        },
      );
  }
  return wallet;
}

describe('PublishOutbox', () => {
  test('publishes every pending event once, in insertion order per wallet, with its attributes', async () => {
    const wallet = await walletWithBets(3);
    const expected = await sql`
      SELECT id, event_type, payload FROM outbox_messages WHERE partition_key = ${wallet.id} ORDER BY seq`;

    await publishAll(publisherWith());

    expect(await unpublishedCount()).toBe(0);
    const received = (await drainEvents()).filter((m) => m.Attributes?.MessageGroupId === wallet.id);
    expect(received.map((m) => JSON.parse(m.Body ?? '{}').eventId)).toEqual(
      expected.map((e: { id: string }) => e.id),
    );
    expect(JSON.parse(received[1]?.Body ?? '{}')).toEqual(expected[1].payload);
    expect(received[1]?.MessageAttributes?.eventType?.StringValue).toBe(expected[1].event_type);
    expect(received[1]?.MessageAttributes?.correlationId?.StringValue).toBe('corr-0');
    expect((await publisherWith().runOnce()).claimed).toBe(0);
  });

  test('three concurrent publishers send each event exactly once', async () => {
    for (let i = 0; i < 10; i++) await walletWithBets(4);
    const [{ n: pending }] =
      await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    expect(pending).toBe(90);

    const counters = Array.from(
      { length: 3 },
      () => new CountingPublisher(new SqsEventPublisher(sqs, queues.events)),
    );
    await Promise.all(counters.map((publisher) => publishAll(publisherWith({ publisher }))));

    const sent = counters.flatMap((c) => c.sent);
    expect(sent).toHaveLength(pending);
    expect(new Set(sent).size).toBe(pending);
    expect(await unpublishedCount()).toBe(0);
    expect(new Set((await drainEvents()).map((m) => JSON.parse(m.Body ?? '{}').eventId)).size).toBe(pending);
  });

  test('a broker outage reschedules with backoff and nothing is lost when it comes back', async () => {
    await walletWithBets(2);
    const clock = new FakeClock();
    const metrics = new PromMetrics();
    const outage = createSqsClient({
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      requestTimeoutMs: 1_500,
    });

    await Bun.$`docker compose pause ministack`.quiet();
    try {
      const report = await publisherWith({
        clock,
        metrics,
        publisher: new SqsEventPublisher(outage, queues.events),
      }).runOnce();
      expect(report).toMatchObject({ claimed: 5, published: 0, failed: 5 });
    } finally {
      await Bun.$`docker compose unpause ministack`.quiet().nothrow();
      outage.destroy();
    }

    const rows = await sql`
      SELECT attempts, next_attempt_at, locked_until, last_error FROM outbox_messages WHERE published_at IS NULL`;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.attempts).toBe(1);
      expect(row.locked_until).toBeNull();
      expect(row.last_error).toBeTruthy();
      expect(row.next_attempt_at.getTime() - clock.now().getTime()).toBe(BACKOFF.baseMs);
    }
    expect(
      (await metrics.registry.getSingleMetric('outbox_publish_failures_total')?.get())?.values[0]?.value,
    ).toBe(5);
    expect((await metrics.registry.getSingleMetric('outbox_pending_messages')?.get())?.values[0]?.value).toBe(
      5,
    );

    expect((await publisherWith({ clock }).runOnce()).claimed).toBe(0); // ainda no backoff
    clock.advance(BACKOFF.baseMs);
    await publishAll(publisherWith({ clock, metrics }));
    expect(await unpublishedCount()).toBe(0);
    expect((await drainEvents()).length).toBe(5);
    expect((await metrics.registry.getSingleMetric('outbox_lag_seconds')?.get())?.values[0]?.value).toBe(0);
  });

  test('events claimed by an instance that died are republished after the lease expires', async () => {
    await walletWithBets(1);
    const clock = new FakeClock();
    const uow = new MikroOrmUnitOfWork(useCases.orm);
    const now = clock.now();
    const orphaned = await uow.run(({ outbox }) =>
      outbox.claimDue(now, new Date(now.getTime() + LEASE_MS), 50),
    );
    expect(orphaned).toHaveLength(3);

    expect((await publisherWith({ clock }).runOnce()).claimed).toBe(0);
    clock.advance(LEASE_MS + 1);
    expect(await publisherWith({ clock }).runOnce()).toMatchObject({ claimed: 3, published: 3 });
    expect(await unpublishedCount()).toBe(0);

    // a instância "morta" voltando e marcando tarde não sobrescreve nada
    await uow.run(({ outbox }) =>
      outbox.markPublished(
        orphaned.map((m) => m.id),
        new Date(0),
      ),
    );
    const [row] =
      await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at = to_timestamp(0)`;
    expect(row.n).toBe(0);
    await drainEvents();
  });

  test('drain keeps publishing full batches in the same tick and stops at the first partial one', async () => {
    await walletWithBets(2); // 5 eventos
    const counting = new CountingPublisher(new SqsEventPublisher(sqs, queues.events));
    const report = await publisherWith({ publisher: counting, batchSize: 2 }).drain();
    expect(report).toEqual({ claimed: 5, published: 5, failed: 0 });
    expect(counting.sent).toHaveLength(5);
    expect(await unpublishedCount()).toBe(0);
    await drainEvents();
  });

  test('the outbox role publishes in the background', async () => {
    const api = await startTestApp(db.url, {
      ROLES: 'api,outbox',
      OUTBOX_TICK_MS: '50',
      SQS_INPUT_QUEUE: names.input,
      SQS_DLQ_QUEUE: names.dlq,
      SQS_EVENTS_QUEUE: names.events,
    });
    try {
      const res = await api.request('POST', '/wallets', {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });
      let pending = 1;
      for (let i = 0; i < 40 && pending > 0; i++) {
        await Bun.sleep(50);
        pending = await unpublishedCount();
      }
      expect(pending).toBe(0);
      const events = await drainEvents();
      expect(events.map((m) => m.Attributes?.MessageGroupId)).toEqual([res.body.id]);
    } finally {
      await api.close();
    }
  });
});
