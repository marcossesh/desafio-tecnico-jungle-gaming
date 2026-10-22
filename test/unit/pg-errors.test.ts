import { describe, expect, test } from 'bun:test';
import { ConflictError, TransientError, UniqueConstraintError } from '../../src/shared/application/errors';
import { translateDatabaseError } from '../../src/shared/infra/database/pg-errors';

const pgError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`pg ${code}`), { code, ...extra });

describe('translateDatabaseError', () => {
  test('unique violation keeps the constraint name', () => {
    const error = translateDatabaseError(pgError('23505', { constraint: 'wallets_player_currency_unique' }));
    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error).toMatchObject({ constraint: 'wallets_player_currency_unique', kind: 'internal' });
  });

  test.each([
    ['55P03', 'lock_timeout'],
    ['40P01', 'deadlock'],
    ['40001', 'serialization'],
  ])('%s is a transient LOCK_TIMEOUT (%s)', (code, reason) => {
    const error = translateDatabaseError(pgError(code));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', reason });
  });

  test.each(['08006', '57P01', 'ECONNREFUSED', 'ECONNRESET'])('%s is SERVICE_UNAVAILABLE', (code) => {
    expect(translateDatabaseError(pgError(code))).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      reason: 'connection',
    });
  });

  test('pool acquisition timeout is SERVICE_UNAVAILABLE', () => {
    expect(translateDatabaseError(new Error('timeout exceeded when trying to connect'))).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  test.each(['23514', '23503', '23000', '22P02'])('%s stays untouched (a bug, mapped to 500)', (code) => {
    const original = pgError(code);
    expect(translateDatabaseError(original)).toBe(original);
  });

  test('application errors and non-errors pass through', () => {
    const conflict = new ConflictError('WALLET_ALREADY_EXISTS', 'dup');
    expect(translateDatabaseError(conflict)).toBe(conflict);
    expect(translateDatabaseError('boom')).toBe('boom');
  });
});
