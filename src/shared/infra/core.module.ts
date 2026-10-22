import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Env } from '../../config/env';
import { MikroOrmUnitOfWork } from './database/mikro-orm-unit-of-work';
import { createOrm } from './database/orm';
import { failpointsFrom } from './failpoints';
import { PromMetrics } from './metrics';
import { createSqsClient } from './sqs';
import { systemClock, uuidV7Generator } from './system';

export const ENV = Symbol('ENV');
export const LOGGER = Symbol('LOGGER');
export const ORM = Symbol('ORM');
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const METRICS = Symbol('METRICS');
export const FAILPOINTS = Symbol('FAILPOINTS');
export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Global()
@Module({})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  static forRoot(env: Env, logger: Logger): DynamicModule {
    const providers = [
      { provide: ENV, useValue: env },
      { provide: LOGGER, useValue: logger },
      {
        provide: ORM,
        useFactory: () => createOrm({ clientUrl: env.DATABASE_URL, poolMax: env.DB_POOL_MAX }),
      },
      { provide: UNIT_OF_WORK, inject: [ORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
      { provide: CLOCK, useValue: systemClock },
      { provide: ID_GENERATOR, useValue: uuidV7Generator },
      { provide: METRICS, useValue: new PromMetrics() },
      { provide: FAILPOINTS, useValue: failpointsFrom(env.FAILPOINTS) },
      {
        provide: SQS_CLIENT,
        useValue: createSqsClient({ endpoint: env.SQS_ENDPOINT, region: env.AWS_REGION }),
      },
    ];
    return { module: CoreModule, providers, exports: providers.map((p) => p.provide) };
  }

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}
