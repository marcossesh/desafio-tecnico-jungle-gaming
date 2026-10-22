import { z } from 'zod';
import type { MoneyProps } from '../../shared/money/money';
import { LEDGER_PAGE_DEFAULT, LEDGER_PAGE_MAX } from '../application/wallet-queries';

// Money fica `unknown` aqui: Money.from valida e responde INVALID_MONEY, não VALIDATION_ERROR.
export const openWalletBody = z.object({
  playerId: z.uuid(),
  initialBalance: z.custom<MoneyProps>((value) => value !== undefined, 'initialBalance is required'),
});

export const walletIdParam = z.uuid();

export const ledgerQuery = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(LEDGER_PAGE_MAX).default(LEDGER_PAGE_DEFAULT),
});
