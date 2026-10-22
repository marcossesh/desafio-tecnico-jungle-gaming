import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Logger } from 'pino';
import type { Env } from '../../config/env';
import { ENV, LOGGER, SQS_CLIENT } from '../../shared/infra/core.module';
import { resolveQueueUrls } from '../../shared/infra/sqs';
import { ProcessWagerTransaction } from '../application/process-wager-transaction';
import { SqsConsumer } from './sqs-consumer';

export const WAGER_CONSUMER_NAME = 'wager-consumer';

/** Liga o consumidor só nas instâncias com o papel `consumer`; filas resolvidas por nome no boot. */
@Injectable()
export class SqsConsumerHost implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: SqsConsumer | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.ROLES.includes('consumer')) return;
    const queues = await resolveQueueUrls(this.sqs, {
      input: this.env.SQS_INPUT_QUEUE,
      dlq: this.env.SQS_DLQ_QUEUE,
      events: this.env.SQS_EVENTS_QUEUE,
    });
    this.consumer = new SqsConsumer(this.sqs, this.processWager, this.logger, {
      consumerName: WAGER_CONSUMER_NAME,
      queues,
      maxAttempts: this.env.SQS_MAX_ATTEMPTS,
      retryBaseSeconds: this.env.SQS_RETRY_BASE_SECONDS,
      waitTimeSeconds: 20,
      maxMessages: 10,
      shutdownGraceMs: this.env.SHUTDOWN_GRACE_MS,
    });
    this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }
}
