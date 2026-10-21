// Comportamentos de SQS FIFO dos quais consumidor e outbox dependem, validados contra o emulador real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteQueueCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient, ensureQueues, type QueueUrls } from '../../src/shared/infra/sqs';

const MAX_ATTEMPTS = 2; // redrive em maxAttempts + 1 = 3 recebimentos

let sqs: SQSClient;
let q: QueueUrls;

beforeAll(async () => {
  sqs = createSqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  q = await ensureQueues(
    sqs,
    { input: `t-${suffix}-in.fifo`, dlq: `t-${suffix}-dlq.fifo`, events: `t-${suffix}-ev.fifo` },
    { maxAttempts: MAX_ATTEMPTS, visibilityTimeoutSeconds: 30 },
  );
});

afterAll(async () => {
  for (const url of Object.values(q)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
});

async function receive(url: string, max = 10, wait = 1): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: wait,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }),
  );
  return res.Messages ?? [];
}

async function release(url: string, msg: Message, seconds = 0): Promise<void> {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: url,
      ReceiptHandle: msg.ReceiptHandle,
      VisibilityTimeout: seconds,
    }),
  );
}

describe('SQS FIFO emulator capabilities', () => {
  test('SendMessageBatch preserves order within a group and drops duplicate deduplication ids', async () => {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: q.events,
        Entries: ['e1', 'e2', 'e3'].map((id) => ({
          Id: id,
          MessageBody: id,
          MessageGroupId: 'wallet-a',
          MessageDeduplicationId: id,
        })),
      }),
    );
    // republicação pela outbox após crash
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: q.events,
        MessageBody: 'e2',
        MessageGroupId: 'wallet-a',
        MessageDeduplicationId: 'e2',
      }),
    );

    const bodies: string[] = [];
    for (let i = 0; i < 5 && bodies.length < 3; i++) {
      for (const m of await receive(q.events)) {
        bodies.push(m.Body ?? '');
        await release(q.events, m, 60);
      }
    }
    expect(bodies).toEqual(['e1', 'e2', 'e3']);
    expect(await receive(q.events, 10, 1)).toHaveLength(0);
  });

  test('an in-flight message blocks its own group but not other groups', async () => {
    const send = (group: string, body: string) =>
      sqs.send(new SendMessageCommand({ QueueUrl: q.input, MessageBody: body, MessageGroupId: group }));
    await send('wallet-1', 'w1-a');
    await send('wallet-1', 'w1-b');
    await send('wallet-2', 'w2-a');

    const first = await receive(q.input, 1);
    expect(first.map((m) => m.Body)).toEqual(['w1-a']);

    const next = await receive(q.input, 10);
    expect(next.map((m) => m.Body)).toEqual(['w2-a']); // w1-b segue bloqueada atrás de w1-a

    const [w1a] = first;
    if (!w1a) throw new Error('unreachable');
    await release(q.input, w1a, 60);
    for (const m of next) await release(q.input, m, 60);
  });

  test('ApproximateReceiveCount increments on redelivery and the redrive policy moves to the DLQ', async () => {
    await sqs.send(
      new SendMessageCommand({ QueueUrl: q.input, MessageBody: 'poison', MessageGroupId: 'wallet-poison' }),
    );

    const counts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const msgs = (await receive(q.input)).filter((m) => m.Body === 'poison');
      for (const m of msgs) {
        counts.push(Number(m.Attributes?.ApproximateReceiveCount));
        await release(q.input, m, 0); // simula falha transitória
      }
      if (counts.length === MAX_ATTEMPTS + 1) break;
    }
    expect(counts).toEqual([1, 2, 3]);

    let inDlq: Message[] = [];
    for (let i = 0; i < 5 && inDlq.length === 0; i++) {
      // o redrive ocorre no receive seguinte ao estouro de maxReceiveCount
      await receive(q.input, 10, 1);
      inDlq = (await receive(q.dlq, 10, 1)).filter((m) => m.Body === 'poison');
    }
    expect(inDlq).toHaveLength(1);
  });

  test('ChangeMessageVisibility delays redelivery (backoff)', async () => {
    await sqs.send(
      new SendMessageCommand({ QueueUrl: q.input, MessageBody: 'backoff', MessageGroupId: 'wallet-backoff' }),
    );
    const [msg] = (await receive(q.input)).filter((m) => m.Body === 'backoff');
    if (!msg) throw new Error('message not received');
    await release(q.input, msg, 2);

    const tooEarly = (await receive(q.input, 10, 0)).filter((m) => m.Body === 'backoff');
    expect(tooEarly).toHaveLength(0);

    await Bun.sleep(2_500);
    const later = (await receive(q.input, 10, 1)).filter((m) => m.Body === 'backoff');
    expect(later).toHaveLength(1);
    expect(Number(later[0]?.Attributes?.ApproximateReceiveCount)).toBe(2);
  });
});
