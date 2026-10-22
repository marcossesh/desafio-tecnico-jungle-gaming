import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../src/shared/infra/sqs';

const [walletId, playerId, kind = 'BET', amount = '10.00', referenceExternalTransactionId] =
  process.argv.slice(2);
if (!walletId || !playerId) {
  console.error(
    'usage: bun run sqs:send <walletId> <playerId> [kind] [amount] [referenceExternalTransactionId]',
  );
  process.exit(1);
}

const env = process.env;
const sqs = createSqsClient({
  endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: env.AWS_REGION ?? 'us-east-1',
});
const { QueueUrl } = await sqs.send(
  new GetQueueUrlCommand({ QueueName: env.SQS_INPUT_QUEUE ?? 'wager-transactions.fifo' }),
);

const externalTransactionId = `sqs-${Bun.randomUUIDv7()}`;
const message = {
  messageId: `msg-${Bun.randomUUIDv7()}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId && { referenceExternalTransactionId }),
  },
};
await sqs.send(
  new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(message), MessageGroupId: walletId }),
);
console.log(JSON.stringify({ msg: 'message sent', messageId: message.messageId, externalTransactionId }));
