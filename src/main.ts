import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './shared/infra/logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const app = await createApp(env, logger);
  await app.listen(env.PORT, '0.0.0.0');

  logger.info({ port: env.PORT, roles: env.ROLES }, 'wagering-processor started');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
