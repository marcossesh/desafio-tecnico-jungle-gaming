import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { createLogger, NestPinoLogger } from './shared/infra/logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger(logger) });
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');

  logger.info({ port: env.PORT, roles: env.ROLES }, 'wagering-processor started');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
