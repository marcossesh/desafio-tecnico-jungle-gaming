import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/money/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { applyWager } from '../../src/wagering/domain/wager-applier';
import type { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-kind';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import type { Wallet } from '../../src/wallet/domain/wallet';
import { applyCtx, Kind, openWallet, processed, wager } from './fixtures';

function refOf(tx: WagerTransaction) {
  return { referenceExternalTransactionId: tx.externalTransactionId };
}

function expectRejected(tx: WagerTransaction, wallet: Wallet, code: FailureCode, balance: string) {
  expect(tx.status).toBe(Status.Rejected);
  expect(tx.failureCode).toBe(code);
  expect(wallet.balance.amount).toBe(balance);
}

describe('BET', () => {
  test('debits and produces one DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const tx = wager(wallet, Kind.Bet, '25.00');
    const outcome = applyWager(tx, wallet, applyCtx());

    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error('unreachable');
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('75.00');
    expect(tx.resultBalance?.amount).toBe('75.00');
  });

  test('insufficient funds is rejected without moving the balance', () => {
    const wallet = openWallet('10.00');
    const tx = processed(wallet, Kind.Bet, '10.01');
    expectRejected(tx, wallet, FailureCode.InsufficientFunds, '10.00');
    expect(wallet.version).toBe(1);
    expect(tx.resultBalance?.amount).toBe('10.00');
  });

  test('scenario 8: 100.00, two bets of 80.00 → one PROCESSED, one INSUFFICIENT_FUNDS, balance 20.00', () => {
    const wallet = openWallet('100.00');
    const first = processed(wallet, Kind.Bet, '80.00');
    const second = processed(wallet, Kind.Bet, '80.00');
    expect(first.status).toBe(Status.Processed);
    expectRejected(second, wallet, FailureCode.InsufficientFunds, '20.00');
    expect(wallet.version).toBe(2);
  });
});

describe('WIN', () => {
  test('credits without a reference', () => {
    const wallet = openWallet('0');
    const tx = processed(wallet, Kind.Win, '50.00');
    expect(tx.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('50.00');
  });

  test('may reference the BET of the same round', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '10.00');
    const win = processed(wallet, Kind.Win, '30.00', refOf(bet), { reference: bet });
    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('120.00');
  });

  test('referencing a BET that is not there yet waits', () => {
    const wallet = openWallet('100.00');
    const win = processed(wallet, Kind.Win, '30.00', { referenceExternalTransactionId: 'bet-later' });
    expect(win.status).toBe(Status.PendingReference);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('referencing an already reversed BET is rejected', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '10.00');
    const win = processed(wallet, Kind.Win, '30.00', refOf(bet), {
      reference: bet,
      referenceAlreadyReversed: true,
    });
    expectRejected(win, wallet, FailureCode.ReferenceAlreadyReversed, '90.00');
  });

  test('a credit past the balance limit is rejected without moving the balance', () => {
    const wallet = openWallet('999999999999999999.00');
    const win = processed(wallet, Kind.Win, '1.00');
    expectRejected(win, wallet, FailureCode.BalanceLimitExceeded, '999999999999999999.00');
    expect(wallet.version).toBe(1);
  });
});

describe('LOSS', () => {
  test('is processed without moving the balance or producing an entry', () => {
    const wallet = openWallet('100.00');
    const tx = wager(wallet, Kind.Loss, '0');
    const outcome = applyWager(tx, wallet, applyCtx());
    expect(outcome).toEqual({ status: Status.Processed, entry: undefined });
    expect(tx.status).toBe(Status.Processed);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
  });
});

describe('REFUND', () => {
  test('credits back a PROCESSED BET', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '40.00');
    const refund = processed(wallet, Kind.Refund, '40.00', refOf(bet), { reference: bet });
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('can only reference a BET', () => {
    const wallet = openWallet('100.00');
    const win = processed(wallet, Kind.Win, '10.00');
    const refund = processed(wallet, Kind.Refund, '10.00', refOf(win), { reference: win });
    expectRejected(refund, wallet, FailureCode.ReferenceKindNotAllowed, '110.00');
  });

  test('amount must equal the reference (no partial reversal)', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '40.00');
    const refund = processed(wallet, Kind.Refund, '39.99', refOf(bet), { reference: bet });
    expectRejected(refund, wallet, FailureCode.ReferenceAmountMismatch, '60.00');
  });

  test('a BET is reversed at most once', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '40.00');
    const refund = processed(wallet, Kind.Refund, '40.00', refOf(bet), {
      reference: bet,
      referenceAlreadyReversed: true,
    });
    expectRejected(refund, wallet, FailureCode.ReferenceAlreadyReversed, '60.00');
  });

  test('a REJECTED BET cannot be refunded', () => {
    const wallet = openWallet('10.00');
    const bet = processed(wallet, Kind.Bet, '50.00');
    const refund = processed(wallet, Kind.Refund, '50.00', refOf(bet), { reference: bet });
    expectRejected(refund, wallet, FailureCode.ReferenceNotProcessed, '10.00');
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '30.00');
    const rollback = processed(wallet, Kind.Rollback, '30.00', refOf(bet), { reference: bet });
    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('of a WIN debits', () => {
    const wallet = openWallet('0');
    const win = processed(wallet, Kind.Win, '30.00');
    const rollback = processed(wallet, Kind.Rollback, '30.00', refOf(win), { reference: win });
    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('of a REFUND debits', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '30.00');
    const refund = processed(wallet, Kind.Refund, '30.00', refOf(bet), { reference: bet });
    const rollback = processed(wallet, Kind.Rollback, '30.00', refOf(refund), { reference: refund });
    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('70.00');
  });

  test('that would make the balance negative is rejected with its own code', () => {
    const wallet = openWallet('0');
    const win = processed(wallet, Kind.Win, '30.00');
    processed(wallet, Kind.Bet, '20.00');
    const rollback = processed(wallet, Kind.Rollback, '30.00', refOf(win), { reference: win });
    expectRejected(rollback, wallet, FailureCode.InsufficientFundsForReversal, '10.00');
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
  });

  test('cannot reference a LOSS', () => {
    const wallet = openWallet('100.00');
    const loss = processed(wallet, Kind.Loss, '0');
    const rollback = processed(wallet, Kind.Rollback, '1.00', refOf(loss), { reference: loss });
    expectRejected(rollback, wallet, FailureCode.ReferenceKindNotAllowed, '100.00');
  });
});

describe('reference must belong to the same provider, player, wallet, currency and round', () => {
  test.each([
    ['round', { roundId: 'other-round' }],
    ['provider', { providerId: 'provider-b' }],
  ])('different %s → REFERENCE_MISMATCH', (_, overrides) => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '10.00');
    const refund = processed(
      wallet,
      Kind.Refund,
      '10.00',
      { ...refOf(bet), ...overrides },
      { reference: bet },
    );
    expectRejected(refund, wallet, FailureCode.ReferenceMismatch, '90.00');
  });

  test('reference from another wallet → REFERENCE_MISMATCH', () => {
    const walletA = openWallet('100.00');
    const walletB = openWallet('100.00');
    const betOnA = processed(walletA, Kind.Bet, '10.00');
    const refundOnB = processed(walletB, Kind.Refund, '10.00', refOf(betOnA), { reference: betOnA });
    expectRejected(refundOnB, walletB, FailureCode.ReferenceMismatch, '100.00');
  });
});

describe('operation vs wallet', () => {
  test('currency different from the wallet → CURRENCY_MISMATCH, persisted as REJECTED', () => {
    const wallet = openWallet('100.00');
    const tx = wager(wallet, Kind.Bet, '10.00', { money: Money.from({ amount: '10.00', currency: 'USD' }) });
    applyWager(tx, wallet, applyCtx());
    expectRejected(tx, wallet, FailureCode.CurrencyMismatch, '100.00');
  });

  test('player that does not own the wallet → WALLET_PLAYER_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const tx = processed(wallet, Kind.Bet, '10.00', { playerId: crypto.randomUUID() });
    expectRejected(tx, wallet, FailureCode.WalletPlayerMismatch, '100.00');
  });

  test('applying to a different wallet is a programming error', () => {
    const walletA = openWallet('100.00');
    const walletB = openWallet('100.00');
    expect(() => applyWager(wager(walletA, Kind.Bet, '1.00'), walletB, applyCtx())).toThrow();
  });
});

describe('out-of-order references', () => {
  test('missing reference → PENDING_REFERENCE without touching the balance', () => {
    const wallet = openWallet('100.00');
    const rollback = processed(wallet, Kind.Rollback, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(rollback.status).toBe(Status.PendingReference);
    expect(rollback.nextReferenceCheckAt).toBeDefined();
    expect(wallet.version).toBe(1);
  });

  test('a reference that is itself pending keeps the dependent waiting', () => {
    const wallet = openWallet('100.00');
    const refund = processed(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' });
    const rollback = processed(wallet, Kind.Rollback, '10.00', refOf(refund), { reference: refund });
    expect(rollback.status).toBe(Status.PendingReference);
  });

  test('reference arrives later → reprocessing applies the reversal', () => {
    const wallet = openWallet('100.00');
    const refund = processed(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    const bet = processed(wallet, Kind.Bet, '10.00', { externalTransactionId: 'bet-1' });
    applyWager(refund, wallet, applyCtx({ reference: bet }));
    expect(refund.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('exhausting attempts rejects with REFERENCE_NOT_FOUND', () => {
    const wallet = openWallet('100.00');
    const refund = processed(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'never' });
    const ctx = applyCtx({ maxReferenceAttempts: 3 });

    expect(applyWager(refund, wallet, ctx).status).toBe(Status.PendingReference);
    expect(applyWager(refund, wallet, ctx).status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(2);
    expect(applyWager(refund, wallet, ctx)).toEqual({
      status: Status.Rejected,
      code: FailureCode.ReferenceNotFound,
    });
    expect(wallet.balance.amount).toBe('100.00');
  });
});
