import { Module } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Metrics } from '../shared/application/metrics';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import type { Clock, IdGenerator } from '../shared/domain/ports';
import { CLOCK, ID_GENERATOR, LOGGER, METRICS, UNIT_OF_WORK } from '../shared/infra/core.module';
import { OpenWallet } from './application/open-wallet';
import { ReconcileWallet } from './application/reconcile-wallet';
import { WalletQueries } from './application/wallet-queries';
import { WalletsController } from './http/wallets.controller';

// Casos de uso não conhecem o Nest: são montados aqui por factory.
@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: OpenWallet,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new OpenWallet(uow, ids, clock),
    },
    {
      provide: WalletQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
    },
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK, METRICS, LOGGER],
      useFactory: (uow: UnitOfWork, metrics: Metrics, logger: Logger) =>
        new ReconcileWallet(uow, metrics, logger),
    },
  ],
})
export class WalletModule {}
