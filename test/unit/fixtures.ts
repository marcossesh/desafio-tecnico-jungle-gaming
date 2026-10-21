import { Money } from '../../src/shared/money/money';

export const T0 = new Date('2026-07-29T15:00:00.000Z');

export const id = (): string => crypto.randomUUID();
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
