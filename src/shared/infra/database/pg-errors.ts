import { ConnectionException } from '@mikro-orm/postgresql';
import {
  ApplicationError,
  TransientError,
  type TransientReason,
  UniqueConstraintError,
} from '../../application/errors';

const LOCK_REASONS: Readonly<Record<string, TransientReason>> = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
  '40001': 'serialization',
};

// Classe 08 (conexão), 57P0x (shutdown/crash do servidor) e erros de socket/pool do driver.
const CONNECTION_CODES = /^(08|57P0[1-3]$|ECONNREFUSED$|ECONNRESET$|ETIMEDOUT$|EPIPE$|ENOTFOUND$|EAI_AGAIN$)/;
const CONNECTION_MESSAGES = /timeout exceeded when trying to connect|Connection terminated/i;

/** Erros do Postgres que o chamador sabe tratar viram ApplicationError; o resto segue intacto (500). */
export function translateDatabaseError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof ApplicationError) return error;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  if (code === '23505') {
    return new UniqueConstraintError(typeof constraint === 'string' ? constraint : undefined, {
      cause: error,
    });
  }
  const lockReason = typeof code === 'string' ? LOCK_REASONS[code] : undefined;
  if (lockReason) {
    return new TransientError('LOCK_TIMEOUT', lockReason, 'Wallet is busy, retry with the same key', {
      cause: error,
    });
  }
  if (
    error instanceof ConnectionException ||
    (typeof code === 'string' && CONNECTION_CODES.test(code)) ||
    CONNECTION_MESSAGES.test(error.message)
  ) {
    return new TransientError('SERVICE_UNAVAILABLE', 'connection', 'Database unavailable', { cause: error });
  }
  return error;
}
