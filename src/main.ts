import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './shared/infra/logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const app = await createApp(env, logger);
  await app.listen(env.PORT, '0.0.0.0');
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : env.PORT;

  logger.info({ port, roles: env.ROLES }, 'wagering-processor started');

  // Sem enableShutdownHooks: o Nest reenvia o sinal a si mesmo após o close, e como PID 1 no container isso é ignorado.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down');
      app.close().then(
        () => {
          logger.info('shutdown complete');
          process.exit(0);
        },
        (err: unknown) => {
          logger.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
    });
  }
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
