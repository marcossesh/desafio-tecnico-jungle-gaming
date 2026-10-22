import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { HealthController } from './health/health.controller';
import { CoreModule } from './shared/infra/core.module';
import { WageringModule } from './wagering/wagering.module';
import { WalletModule } from './wallet/wallet.module';

@Module({})
export class AppModule {}

export function appModule(env: Env, logger: Logger): DynamicModule {
  return {
    module: AppModule,
    imports: [CoreModule.forRoot(env, logger), WalletModule, WageringModule],
    controllers: [HealthController],
  };
}
