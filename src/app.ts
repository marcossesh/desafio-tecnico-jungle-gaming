import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';
import { appModule } from './app.module';
import type { Env } from './config/env';
import { correlationIdMiddleware } from './shared/http/correlation-id';
import { HttpErrorFilter } from './shared/http/http-error.filter';
import { NestPinoLogger } from './shared/infra/logger';

export async function createApp(env: Env, logger: Logger): Promise<INestApplication> {
  const app = await NestFactory.create(appModule(env, logger), {
    logger: new NestPinoLogger(logger),
  });
  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new HttpErrorFilter(logger));
  return app;
}
