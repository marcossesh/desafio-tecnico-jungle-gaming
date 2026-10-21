import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../shared/money/money';

/** Subconjunto de negócio que identifica uma operação. Header, messageId e metadados ficam de fora. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/** Chaves ordenadas recursivamente; `undefined` é omitido. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** `amount` é normalizado para 2 casas antes do hash. */
export function wagerPayloadHash(payload: WagerPayload): string {
  const subset = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  };
  return canonicalHash(subset);
}
