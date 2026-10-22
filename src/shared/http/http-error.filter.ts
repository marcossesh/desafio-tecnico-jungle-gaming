import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { ApplicationError, type ErrorKind } from '../application/errors';
import { DomainError } from '../domain/errors';
import { correlationIdOf } from './correlation-id';

interface HttpErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

const STATUS_BY_KIND: Readonly<Record<ErrorKind, number>> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  transient: 503,
  internal: 500,
};

// Erros de domínio que indicam payload malformado; os demais são rejeição de regra (422).
const INPUT_ERROR_CODES = new Set(['VALIDATION_ERROR', 'INVALID_MONEY', 'KIND_NOT_ALLOWED']);

const INTERNAL: HttpErrorBody = { code: 'INTERNAL_ERROR', message: 'Internal error', retryable: true };

function toHttpError(exception: unknown): { status: number; body: HttpErrorBody } {
  if (exception instanceof ApplicationError) {
    const status = STATUS_BY_KIND[exception.kind];
    if (status === 500) return { status, body: INTERNAL };
    return {
      status,
      body: {
        code: exception.code,
        message: exception.message,
        retryable: exception.kind === 'transient',
        ...(exception.details && { details: exception.details }),
      },
    };
  }
  if (exception instanceof DomainError) {
    const status = INPUT_ERROR_CODES.has(exception.code) ? 400 : 422;
    return { status, body: { code: exception.code, message: exception.message, retryable: false } };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status >= 500) return { status: 500, body: INTERNAL };
    const code = status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR';
    return { status, body: { code, message: exception.message, retryable: false } };
  }
  // body-parser (JSON malformado, payload grande) sinaliza com `status` 4xx.
  const status = (exception as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      status: 400,
      body: { code: 'VALIDATION_ERROR', message: 'Malformed request body', retryable: false },
    };
  }
  return { status: 500, body: INTERNAL };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = correlationIdOf(res);
    const { status, body } = toHttpError(exception);

    if (status === 500) this.logger.error({ err: exception, correlationId }, 'request failed');
    else if (status === 503) this.logger.warn({ code: body.code, correlationId }, 'transient failure');
    if (status === 503) res.setHeader('Retry-After', '1');
    res.status(status).json({ error: body, correlationId });
  }
}
