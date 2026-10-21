import { describe, expect, test } from 'bun:test';
import { canonicalJson, type WagerPayload, wagerPayloadHash } from '../../src/wagering/domain/payload-hash';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys recursively and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  test('omits undefined, keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  test('rejects values without a stable JSON form', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe('wagerPayloadHash', () => {
  test('is a 64-char hex SHA-256', () => {
    expect(wagerPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerPayload;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
  });

  test('normalizes the amount scale ("25" and "25.00" are the same operation)', () => {
    expect(wagerPayloadHash({ ...payload, money: { amount: '25', currency: 'BRL' } })).toBe(
      wagerPayloadHash(payload),
    );
  });

  test('missing and undefined reference hash the same', () => {
    expect(wagerPayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(
      wagerPayloadHash(payload),
    );
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['walletId', { walletId: 'other' }],
    ['roundId', { roundId: 'round-988' }],
    ['reference', { referenceExternalTransactionId: 'bet-1' }],
  ])(
    'same idempotency key with a different %s is a different payload (conflict, not replay)',
    (_, change) => {
      expect(wagerPayloadHash({ ...payload, ...change })).not.toBe(wagerPayloadHash(payload));
    },
  );
});
