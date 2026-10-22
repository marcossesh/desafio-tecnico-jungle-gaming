import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Logger } from 'pino';
import type { Env } from '../../config/env';
import type { Metrics } from '../../shared/application/metrics';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { Clock } from '../../shared/domain/ports';
import { CLOCK, ENV, LOGGER, METRICS, SQS_CLIENT, UNIT_OF_WORK } from '../../shared/infra/core.module';
import { PeriodicTask } from '../../shared/infra/periodic-task';
import { resolveQueueUrls } from '../../shared/infra/sqs';
import { PublishOutbox } from '../application/publish-outbox';
import { DEFAULT_OUTBOX_BACKOFF } from '../domain/outbox-message';
import { SqsEventPublisher } from './sqs-event-publisher';

/** Publisher em toda instância com o papel `outbox`; o claim com SKIP LOCKED divide o trabalho. */
@Injectable()
export class OutboxPublisherHost implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private task: PeriodicTask | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.ROLES.includes('outbox')) return;
    const { events } = await resolveQueueUrls(this.sqs, {
      input: this.env.SQS_INPUT_QUEUE,
      dlq: this.env.SQS_DLQ_QUEUE,
      events: this.env.SQS_EVENTS_QUEUE,
    });
    const publish = new PublishOutbox(
      this.uow,
      new SqsEventPublisher(this.sqs, events),
      this.clock,
      this.metrics,
      this.logger,
      { batchSize: 50, leaseMs: this.env.OUTBOX_LEASE_MS, backoff: DEFAULT_OUTBOX_BACKOFF },
    );
    this.task = new PeriodicTask(
      'outbox-publisher',
      this.env.OUTBOX_TICK_MS,
      () => publish.runOnce(),
      this.logger,
    );
    this.task.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.task?.stop();
  }
}
