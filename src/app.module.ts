import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { HealthController } from './health/health.controller';
import { MetricsController } from './health/metrics.controller';
import { MessagingModule } from './messaging/messaging.module';
import { ProviderAuthGuard } from './shared/http/provider-auth.guard';
import { AnonymousProviderIdentity, PROVIDER_IDENTITY } from './shared/http/provider-identity';
import { CoreModule } from './shared/infra/core.module';
import { WageringModule } from './wagering/wagering.module';
import { WalletModule } from './wallet/wallet.module';

@Module({})
export class AppModule {}

export function appModule(env: Env, logger: Logger): DynamicModule {
  return {
    module: AppModule,
    imports: [CoreModule.forRoot(env, logger), WalletModule, WageringModule, MessagingModule],
    controllers: [HealthController, MetricsController],
    providers: [
      { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
      { provide: APP_GUARD, useClass: ProviderAuthGuard },
    ],
  };
}
