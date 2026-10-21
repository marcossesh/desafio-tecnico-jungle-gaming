import { Money } from '../../src/shared/money/money';
import { Wallet } from '../../src/wallet/domain/wallet';

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

export const id = (): string => crypto.randomUUID();
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

export function openWallet(balance = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: id(),
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: balance, currency }),
    openingTransactionId: id(),
    openingEntryId: id(),
    at: T0,
  }).wallet;
}
