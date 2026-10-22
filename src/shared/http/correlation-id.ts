import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { currentLogContext, runWithLogContext } from '../infra/log-context';

const HEADER = 'x-correlation-id';
const VALID = /^[A-Za-z0-9._:-]{1,128}$/;
// probes e scrape do Prometheus a cada poucos segundos só gerariam ruído
const QUIET_PATHS = /^\/(health|metrics)(\/|$)/;

/**
 * Aceita o id do chamador se for seguro para log (senão gera um), ecoa na resposta e abre o contexto de log
 * da requisição; ao terminar, registra uma linha com status e duração.
 */
export function requestContextMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(HEADER);
    const correlationId = incoming && VALID.test(incoming) ? incoming : Bun.randomUUIDv7();
    res.locals.correlationId = correlationId;
    res.setHeader(HEADER, correlationId);

    const startedAt = performance.now();
    runWithLogContext({ correlationId, channel: 'http' }, () => {
      const context = currentLogContext();
      if (!QUIET_PATHS.test(req.path)) {
        res.on('finish', () =>
          logger.info(
            {
              ...context,
              method: req.method,
              path: req.path,
              statusCode: res.statusCode,
              durationMs: Math.round(performance.now() - startedAt),
            },
            'http request',
          ),
        );
      }
      next();
    });
  };
}

export function correlationIdOf(res: Response): string {
  return String(res.locals.correlationId ?? '');
}

export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string =>
  correlationIdOf(ctx.switchToHttp().getResponse<Response>()),
);
