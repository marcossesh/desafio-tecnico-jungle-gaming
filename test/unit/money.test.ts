import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/shared/money/money';
import { brl, usd } from './fixtures';

describe('Money.from — input contract', () => {
  test.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.50', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts %p and serializes with fixed scale 2 as %p', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    [''],
    [' 1.00'],
    ['1.00 '],
    ['1e3'],
    ['1E3'],
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['-1.00'],
    ['+1.00'],
    ['01.00'],
    ['1.'],
    ['.5'],
    ['1.005'],
    ['1,00'],
    ['0x10'],
    ['1000000000000000000.00'],
  ])('rejects amount %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([[25], [25.5], [null], [undefined], [10n]])('rejects non-string amount %p', (amount) => {
    expect(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each([['brl'], ['R$'], ['BR'], ['BRLX'], ['']])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('more than 2 decimals is rejected, never rounded', () => {
    expect(() => brl('0.005')).toThrow(InvalidMoneyError);
    expect(() => brl('10.999')).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  test('is exact where binary floating point is not', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  test('stays exact beyond Number.MAX_SAFE_INTEGER cents', () => {
    const big = brl('999999999999999999.98');
    expect(big.add(brl('0.01')).amount).toBe('999999999999999999.99');
    expect(big.minorUnits > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test('accumulating many small amounts does not drift', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10_000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('100.00');
  });

  test('rejects results outside the persistable range', () => {
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });

  test('subtract and negate can go negative internally; serialization keeps the sign', () => {
    const diff = brl('1.00').subtract(brl('1.50'));
    expect(diff.isNegative()).toBe(true);
    expect(diff.amount).toBe('-0.50');
    expect(brl('2.00').negate().amount).toBe('-2.00');
    expect(Money.zero('BRL').negate().isZero()).toBe(true);
  });

  test('comparisons', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.0').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('Money currency conflicts', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s between different currencies throws a domain error', (_, op) => {
    expect(() => op(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('error carries a stable code', () => {
    let error: unknown;
    try {
      brl('1.00').add(usd('1.00'));
    } catch (err) {
      error = err;
    }
    expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
  });

  test('toString and JSON', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
    expect(JSON.stringify({ money: brl('25') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });
});
