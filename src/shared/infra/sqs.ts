import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export function createSqsClient(opts: {
  endpoint: string;
  region: string;
  requestTimeoutMs?: number;
}): SQSClient {
  // Sem credenciais no ambiente o SDK tenta o IMDS da EC2 e trava; o emulador aceita qualquer par.
  const credentials = process.env.AWS_ACCESS_KEY_ID
    ? undefined
    : { accessKeyId: 'test', secretAccessKey: 'test' };
  return new SQSClient({
    endpoint: opts.endpoint,
    region: opts.region,
    // sem timeout, um broker travado prende a chamada para sempre; o default cobre o long poll de 20s
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: opts.requestTimeoutMs ?? 30_000,
      throwOnRequestTimeout: true,
    },
    ...(credentials && { credentials }),
  });
}

export interface QueueNames {
  input: string;
  dlq: string;
  events: string;
}

export interface QueueUrls {
  input: string;
  dlq: string;
  events: string;
}

/** Idempotente. O consumidor move para a DLQ após `maxAttempts`; o redrive (`+1`) cobre crash loops. */
export async function ensureQueues(
  sqs: SQSClient,
  names: QueueNames,
  opts: { maxAttempts: number; visibilityTimeoutSeconds?: number },
): Promise<QueueUrls> {
  const fifo = { FifoQueue: 'true' };

  const dlq = await createQueue(sqs, names.dlq, { ...fifo, MessageRetentionPeriod: '1209600' });
  const dlqArn = await queueArn(sqs, dlq);

  const input = await createQueue(sqs, names.input, {
    ...fifo,
    // provedores nem sempre enviam MessageDeduplicationId
    ContentBasedDeduplication: 'true',
    VisibilityTimeout: String(opts.visibilityTimeoutSeconds ?? 30),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: opts.maxAttempts + 1 }),
  });

  // a outbox sempre envia MessageDeduplicationId = eventId
  const events = await createQueue(sqs, names.events, { ...fifo, ContentBasedDeduplication: 'false' });

  return { input, dlq, events };
}

async function createQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const res = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (!res.QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
  return res.QueueUrl;
}

async function queueArn(sqs: SQSClient, url: string): Promise<string> {
  const res = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  const arn = res.Attributes?.QueueArn;
  if (!arn) throw new Error(`QueueArn not found for ${url}`);
  return arn;
}

export async function resolveQueueUrls(sqs: SQSClient, names: QueueNames): Promise<QueueUrls> {
  const url = async (QueueName: string) => {
    const res = await sqs.send(new GetQueueUrlCommand({ QueueName }));
    if (!res.QueueUrl) throw new Error(`Queue ${QueueName} not found`);
    return res.QueueUrl;
  };
  return { input: await url(names.input), dlq: await url(names.dlq), events: await url(names.events) };
}
