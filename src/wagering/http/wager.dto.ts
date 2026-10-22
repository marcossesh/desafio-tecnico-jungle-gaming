import { z } from 'zod';
import type { MoneyProps } from '../../shared/money/money';

const text = (max: number) => z.string().min(1).max(max);

// `kind` e `money` ficam com o domínio: ele responde KIND_NOT_ALLOWED / INVALID_MONEY em vez de VALIDATION_ERROR.
export const wagerBody = z.object({
  providerId: text(100),
  externalTransactionId: text(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text(200),
  gameId: text(200),
  kind: text(20),
  money: z.custom<MoneyProps>((value) => value !== undefined, 'money is required'),
  referenceExternalTransactionId: text(200).optional(),
});

export const idempotencyKeyHeader = text(200);

export const transactionIdParam = z.uuid();

export const externalIdParams = z.object({ providerId: text(100), externalTransactionId: text(200) });
