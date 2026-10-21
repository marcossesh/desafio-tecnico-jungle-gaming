import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/shared/domain/errors';
import { CurrencyMismatchError, Money } from '../../src/shared/money/money';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { InsufficientFundsError, Wallet } from '../../src/wallet/domain/wallet';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';
import { brl, id, openWallet, PLAYER_ID, T0, usd } from './fixtures';

const T1 = new Date(T0.getTime() + 1_000);

describe('Wallet.open', () => {
  test('positive initial balance produces the opening CREDIT entry at version 1', () => {
    const openingTransactionId = id();
    const { wallet, openingEntry } = Wallet.open({
      id: id(),
      playerId: PLAYER_ID,
      initialBalance: brl('1000.00'),
      openingTransactionId,
      openingEntryId: id(),
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe(openingTransactionId);
  });

  test('zero initial balance has no ledger entry and still starts at version 1', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: id(),
      playerId: PLAYER_ID,
      initialBalance: brl('0'),
      openingTransactionId: id(),
      openingEntryId: id(),
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('negative initial balance is rejected', () => {
    expect(() =>
      Wallet.open({
        id: id(),
        playerId: PLAYER_ID,
        initialBalance: Money.ofMinor(-1n, 'BRL'),
        openingTransactionId: id(),
        openingEntryId: id(),
        at: T0,
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe('Wallet movements', () => {
  test('debit returns the matching entry and bumps version exactly once', () => {
    const wallet = openWallet('100.00');
    const txId = id();
    const entry = wallet.debit(brl('80.00'), txId, id(), T1);

    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.transactionId).toBe(txId);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
  });

  test('credit', () => {
    const wallet = openWallet('0');
    const entry = wallet.credit(brl('0.01'), id(), id(), T1);
    expect(wallet.balance.amount).toBe('0.01');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('debiting more than the balance throws and leaves the wallet untouched', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('80.00'), id(), id(), T1);
    expect(() => wallet.debit(brl('80.00'), id(), id(), T1)).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('debiting the exact balance reaches zero, never below', () => {
    const wallet = openWallet('10.00');
    wallet.debit(brl('10.00'), id(), id(), T1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.canDebit(brl('0.01'))).toBe(false);
  });

  test('operation currency must match the wallet currency', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(usd('1.00'), id(), id(), T1)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd('1.00'), id(), id(), T1)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('zero-amount movements are not allowed (version only changes with balance)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(brl('0'), id(), id(), T1)).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test('ledger reconstructs the balance after a sequence of movements', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: id(),
      playerId: PLAYER_ID,
      initialBalance: brl('50.00'),
      openingTransactionId: id(),
      openingEntryId: id(),
      at: T0,
    });
    const entries = [openingEntry as WalletLedgerEntry];
    entries.push(wallet.debit(brl('10.00'), id(), id(), T1));
    entries.push(wallet.credit(brl('25.55'), id(), id(), T1));
    entries.push(wallet.debit(brl('0.55'), id(), id(), T1));

    const fromLedger = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      Money.zero('BRL'),
    );
    expect(fromLedger.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.balanceBefore.equals(entries[i - 1]?.balanceAfter as Money)).toBe(true);
    }
  });

  test('rehydrate restores state without revalidation', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('5.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    createdAt: T0,
  };

  test('create validates the arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('16.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test.each([
    ['zero amount', brl('0'), brl('5.00'), brl('5.00')],
    ['negative balanceAfter', brl('10.00'), brl('5.00'), Money.ofMinor(-500n, 'BRL')],
  ])('create rejects %s', (_, money, balanceBefore, balanceAfter) => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money,
        balanceBefore,
        balanceAfter,
      }),
    ).toThrow(InvariantViolationError);
  });

  test('create rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: usd('1.00'),
        balanceBefore: brl('0'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0'),
      balanceAfter: brl('1.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { walletVersion: number }).walletVersion = 9;
    }).toThrow();
    expect(entry.isBalanced()).toBe(true);
  });
});
