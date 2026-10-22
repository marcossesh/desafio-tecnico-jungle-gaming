import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Logger } from 'pino';
import type { Env } from '../../config/env';
import { ENV, LOGGER } from '../../shared/infra/core.module';
import { PeriodicTask } from '../../shared/infra/periodic-task';
import { ReprocessPendingReferences } from '../application/reprocess-pending-references';

/** Roda em toda instância com o papel `scheduler`; o claim com SKIP LOCKED divide o trabalho entre elas. */
@Injectable()
export class PendingReferenceScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly task: PeriodicTask;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) logger: Logger,
    @Inject(ReprocessPendingReferences) reprocess: ReprocessPendingReferences,
  ) {
    this.task = new PeriodicTask(
      'pending-references',
      env.PENDING_REF_TICK_MS,
      () => reprocess.runOnce(),
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.env.ROLES.includes('scheduler')) this.task.start();
  }

  // antes do onApplicationShutdown do CoreModule, que fecha o pool
  async beforeApplicationShutdown(): Promise<void> {
    await this.task.stop();
  }
}
