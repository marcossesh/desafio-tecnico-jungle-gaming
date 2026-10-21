import { createSqsClient, ensureQueues } from '../src/shared/infra/sqs';

const env = process.env;
const sqs = createSqsClient({
  endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: env.AWS_REGION ?? 'us-east-1',
});

const urls = await ensureQueues(
  sqs,
  {
    input: env.SQS_INPUT_QUEUE ?? 'wager-transactions.fifo',
    dlq: env.SQS_DLQ_QUEUE ?? 'wager-transactions-dlq.fifo',
    events: env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
  },
  { maxAttempts: Number(env.SQS_MAX_ATTEMPTS ?? 5) },
);

console.log(JSON.stringify({ msg: 'queues ready', ...urls }));
