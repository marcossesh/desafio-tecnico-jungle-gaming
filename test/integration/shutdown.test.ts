// Processo real: SIGTERM com long poll em andamento precisa sair limpo e rápido (nada de timer segurando o event loop).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient, ensureQueues, type QueueNames, type QueueUrls } from '../../src/shared/infra/sqs';
import { createTestDatabase, type TestDatabase } from '../support/database';

// timing real do broker/processos (backoff de visibilidade, MiniStack pausado, spawn) excede os 5s padrão
setDefaultTimeout(30_000);

let db: TestDatabase;
let sqs: SQSClient;
let names: QueueNames;
let queues: QueueUrls;

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = createSqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: 'us-east-1',
  });
  const suffix = Bun.randomUUIDv7().slice(-8);
  names = { input: `s-${suffix}-in.fifo`, dlq: `s-${suffix}-dlq.fifo`, events: `s-${suffix}-ev.fifo` };
  queues = await ensureQueues(sqs, names, { maxAttempts: 3 });
});

afterAll(async () => {
  for (const url of Object.values(queues)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  sqs.destroy();
  await db.drop();
});

test('SIGTERM stops every role and exits 0 well within the grace period', async () => {
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: '0',
      ROLES: 'api,consumer,outbox,scheduler',
      DATABASE_URL: db.url,
      SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      SQS_INPUT_QUEUE: names.input,
      SQS_DLQ_QUEUE: names.dlq,
      SQS_EVENTS_QUEUE: names.events,
      SHUTDOWN_GRACE_MS: '25000',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const decoder = new TextDecoder();
  let output = '';
  const reader = child.stdout.getReader();
  while (!output.includes('wagering-processor started')) {
    const { value, done } = await reader.read();
    if (done)
      throw new Error(`process exited before starting:\n${output}${await new Response(child.stderr).text()}`);
    output += decoder.decode(value);
  }
  await Bun.sleep(300); // consumidor já dentro do long poll

  const startedAt = performance.now();
  child.kill('SIGTERM');
  const exitCode = await child.exited;
  const elapsed = performance.now() - startedAt;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    output += decoder.decode(chunk.value);

  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(5_000);
  expect(output).toContain('shutdown complete');
});
