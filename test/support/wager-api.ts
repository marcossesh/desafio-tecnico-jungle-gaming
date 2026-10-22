import { expect } from 'bun:test';
import type { ApiResponse } from './app';

type Request = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<ApiResponse>;

export interface WalletRef {
  id: string;
  playerId: string;
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function openWalletVia(request: Request, amount: string): Promise<WalletRef> {
  const res = await request('POST', '/wallets', {
    playerId: Bun.randomUUIDv7(),
    initialBalance: brl(amount),
  });
  expect(res.status).toBe(201);
  return res.body;
}

export function betPayload(wallet: WalletRef, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('10.00'),
    ...overrides,
  };
}

export function submitVia(request: Request, body: ReturnType<typeof betPayload>, key?: string) {
  return request('POST', '/wagering/transactions', body, {
    'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}`,
  });
}
