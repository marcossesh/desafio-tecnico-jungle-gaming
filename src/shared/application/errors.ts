export type ErrorKind =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'transient'
  | 'internal';

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    readonly kind: ErrorKind,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', 'validation', message, details);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(code: string, message: string) {
    super(code, 'not_found', message);
  }
}

export class ConflictError extends ApplicationError {
  constructor(code: string, message: string) {
    super(code, 'conflict', message);
  }
}

export type TransientReason =
  | 'lock_timeout'
  | 'deadlock'
  | 'serialization'
  | 'version_conflict'
  | 'connection';

export class TransientError extends ApplicationError {
  constructor(
    code: 'LOCK_TIMEOUT' | 'SERVICE_UNAVAILABLE',
    readonly reason: TransientReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, 'transient', message, undefined, options);
  }
}

/** Update condicionado por versão não afetou linha: outra transação mudou a wallet. */
export class ConcurrencyConflictError extends TransientError {
  constructor(walletId: string) {
    super('LOCK_TIMEOUT', 'version_conflict', `Wallet ${walletId} changed concurrently`);
  }
}

/** Use cases convertem as violações esperadas; as demais são bug (500). */
export class UniqueConstraintError extends ApplicationError {
  constructor(
    readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(
      'INTERNAL_ERROR',
      'internal',
      `Unique constraint violated: ${constraint ?? 'unknown'}`,
      undefined,
      options,
    );
  }
}
