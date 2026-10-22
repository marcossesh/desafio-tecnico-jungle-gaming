import { Module } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Env } from '../config/env';
import type { Failpoints } from '../shared/application/failpoints';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import type { Clock, IdGenerator } from '../shared/domain/ports';
import { CLOCK, ENV, FAILPOINTS, ID_GENERATOR, LOGGER, UNIT_OF_WORK } from '../shared/infra/core.module';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { ReprocessPendingReferences } from './application/reprocess-pending-references';
import { WagerQueries } from './application/wager-queries';
import { WagerTransactionsController } from './http/wager-transactions.controller';
import { PendingReferenceScheduler } from './infra/pending-reference.scheduler';
import { SqsConsumerHost } from './infra/sqs-consumer.host';

@Module({
  controllers: [WagerTransactionsController],
  providers: [
    {
      provide: ProcessWagerTransaction,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, FAILPOINTS, ENV],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, failpoints: Failpoints, env: Env) =>
        new ProcessWagerTransaction(uow, ids, clock, failpoints, {
          lockTimeoutMs: env.WALLET_LOCK_TIMEOUT_MS,
          pendingReferenceBaseMs: env.PENDING_REF_BASE_MS,
          maxReferenceAttempts: env.PENDING_REF_MAX_ATTEMPTS,
          maxAttempts: 3,
        }),
    },
    {
      provide: ReprocessPendingReferences,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, FAILPOINTS, LOGGER, ENV],
      useFactory: (
        uow: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        failpoints: Failpoints,
        logger: Logger,
        env: Env,
      ) =>
        new ReprocessPendingReferences(uow, ids, clock, failpoints, logger, {
          batchSize: 20,
          claimLeaseMs: 30_000,
          backoff: { baseMs: env.PENDING_REF_BASE_MS, capMs: env.PENDING_REF_CAP_MS },
          maxReferenceAttempts: env.PENDING_REF_MAX_ATTEMPTS,
          lockTimeoutMs: env.WALLET_LOCK_TIMEOUT_MS,
        }),
    },
    PendingReferenceScheduler,
    SqsConsumerHost,
    { provide: WagerQueries, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new WagerQueries(uow) },
  ],
})
export class WageringModule {}
