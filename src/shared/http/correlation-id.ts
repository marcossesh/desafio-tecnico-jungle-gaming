import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const HEADER = 'x-correlation-id';
const VALID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Aceita o id do chamador se for seguro para log; senão gera um. Ecoado na resposta. */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const correlationId = incoming && VALID.test(incoming) ? incoming : Bun.randomUUIDv7();
  res.locals.correlationId = correlationId;
  res.setHeader(HEADER, correlationId);
  next();
}

export function correlationIdOf(res: Response): string {
  return String(res.locals.correlationId ?? '');
}

export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string =>
  correlationIdOf(ctx.switchToHttp().getResponse<Response>()),
);
