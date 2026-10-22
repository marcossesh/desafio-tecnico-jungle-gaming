import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { HealthController } from './health/health.controller';
import { MetricsController } from './health/metrics.controller';
import { MessagingModule } from './messaging/messaging.module';
import { JwtProviderIdentity } from './shared/http/jwt-provider-identity';
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
      { provide: PROVIDER_IDENTITY, useValue: providerIdentity(env) },
      { provide: APP_GUARD, useClass: ProviderAuthGuard },
    ],
  };
}

function providerIdentity(env: Env) {
  if (env.AUTH_MODE === 'none') return new AnonymousProviderIdentity();
  // loadEnv já exige o issuer; falha fechada em vez de cair no modo anônimo
  if (!env.AUTH_ISSUER) throw new Error('AUTH_ISSUER is required when AUTH_MODE is keycloak');
  return new JwtProviderIdentity({
    issuer: env.AUTH_ISSUER,
    audience: env.AUTH_AUDIENCE,
    jwksUrl: env.AUTH_JWKS_URL ?? `${env.AUTH_ISSUER}/protocol/openid-connect/certs`,
  });
}
