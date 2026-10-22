import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient, ensureQueues, type QueueNames, type QueueUrls } from '../../src/shared/infra/sqs';

export interface TestQueues {
  sqs: SQSClient;
  names: QueueNames;
  urls: QueueUrls;
  /** Variáveis de ambiente para uma instância usar estas filas. */
  env: Record<string, string>;
  send(body: unknown, group: string): Promise<void>;
  /** Mensagens visíveis + em voo na fila de entrada. */
  inputDepth(): Promise<number>;
  destroy(): Promise<void>;
}

export async function createTestQueues(options: { visibilityTimeoutSeconds: number; maxAttempts?: number }) {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
  const sqs = createSqsClient({ endpoint, region: 'us-east-1' });
  const suffix = Bun.randomUUIDv7().slice(-8);
  const names = { input: `q-${suffix}-in.fifo`, dlq: `q-${suffix}-dlq.fifo`, events: `q-${suffix}-ev.fifo` };
  const urls = await ensureQueues(sqs, names, {
    maxAttempts: options.maxAttempts ?? 5,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
  });

  const queues: TestQueues = {
    sqs,
    names,
    urls,
    env: {
      SQS_ENDPOINT: endpoint,
      SQS_INPUT_QUEUE: names.input,
      SQS_DLQ_QUEUE: names.dlq,
      SQS_EVENTS_QUEUE: names.events,
    },
    async send(body, group) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: urls.input,
          MessageBody: JSON.stringify(body),
          MessageGroupId: group,
          MessageDeduplicationId: Bun.randomUUIDv7(),
        }),
      );
    },
    async inputDepth() {
      const { Attributes = {} } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: urls.input,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return (
        Number(Attributes.ApproximateNumberOfMessages) +
        Number(Attributes.ApproximateNumberOfMessagesNotVisible)
      );
    },
    async destroy() {
      for (const url of Object.values(urls)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      sqs.destroy();
    },
  };
  return queues;
}

export function wagerMessage(
  wallet: { id: string; playerId: string },
  data: Record<string, unknown> = {},
  messageId = `msg-${Bun.randomUUIDv7()}`,
) {
  const externalTransactionId =
    (data.externalTransactionId as string | undefined) ?? `sqs-${Bun.randomUUIDv7()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...data,
      externalTransactionId,
    },
  };
}
