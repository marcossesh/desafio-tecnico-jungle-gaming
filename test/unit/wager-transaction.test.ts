import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
} from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-kind';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { brl, id, Kind, openWallet, T0, wager } from './fixtures';

const wallet = openWallet('100.00');
const later = new Date(T0.getTime() + 5_000);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as InvalidWagerTransactionError).code;
  }
  return undefined;
}

describe('WagerTransaction.create', () => {
  test('starts PENDING with no outcome', () => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING cannot be submitted', () => {
    expect(codeOf(() => wager(wallet, Kind.Opening, '10.00'))).toBe('KIND_NOT_ALLOWED');
  });

  test('provider "internal" is reserved', () => {
    expect(codeOf(() => wager(wallet, Kind.Bet, '10.00', { providerId: 'internal' }))).toBe(
      'VALIDATION_ERROR',
    );
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires referenceExternalTransactionId', (kind) => {
    expect(codeOf(() => wager(wallet, kind, '10.00'))).toBe('VALIDATION_ERROR');
    expect(() => wager(wallet, kind, '10.00', { referenceExternalTransactionId: 'bet-1' })).not.toThrow();
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('%s requires a positive amount', (kind) => {
    expect(codeOf(() => wager(wallet, kind, '0', { referenceExternalTransactionId: 'r' }))).toBe(
      'INVALID_MONEY',
    );
  });

  test('LOSS accepts zero amount', () => {
    expect(wager(wallet, Kind.Loss, '0').money.isZero()).toBe(true);
  });

  test.each(['roundId', 'gameId', 'externalTransactionId', 'idempotencyKey'] as const)(
    '%s is required',
    (field) => {
      expect(codeOf(() => wager(wallet, Kind.Bet, '1.00', { [field]: '' }))).toBe('VALIDATION_ERROR');
    },
  );
});

describe('WagerTransaction state machine', () => {
  test('PENDING → PROCESSED records reference, balance and time', () => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    tx.markProcessed(undefined, brl('90.00'), later);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultBalance?.amount).toBe('90.00');
    expect(tx.processedAt).toEqual(later);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED keeps the failure code', () => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    tx.reject(FailureCode.InsufficientFunds, brl('5.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toBeUndefined();
  });

  test('PENDING → PENDING_REFERENCE → (miss) → PROCESSED', () => {
    const tx = wager(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(later, brl('100.00'));
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextReferenceCheckAt).toEqual(later);

    tx.recordReferenceMiss(new Date(later.getTime() + 1), brl('100.00'));
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.status).toBe(Status.PendingReference);

    tx.markProcessed(id(), brl('110.00'), later);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  test('PENDING_REFERENCE → FAILED is terminal and auditable', () => {
    const tx = wager(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(later, brl('100.00'));
    tx.fail(FailureCode.ProcessingFailed);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
  });

  test.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, brl('1.00'), later)],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, undefined)],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed)],
  ])('%s is terminal: every transition throws', (_, finish) => {
    const tx = wager(wallet, Kind.Bet, '1.00');
    finish(tx);
    expect(() => tx.markProcessed(undefined, brl('1.00'), later)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, undefined)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(later, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.recordReferenceMiss(later, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  test('a reversal cannot be processed without its resolved reference', () => {
    const tx = wager(wallet, Kind.Rollback, '1.00', { referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.markProcessed(undefined, brl('1.00'), later)).toThrow();
  });

  test('recordReferenceMiss only from PENDING_REFERENCE', () => {
    const tx = wager(wallet, Kind.Refund, '1.00', { referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.recordReferenceMiss(later, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate does not revalidate transitions', () => {
    const tx = WagerTransaction.rehydrate({
      id: 't',
      providerId: 'provider-a',
      externalTransactionId: 'x',
      idempotencyKey: 'provider-a:x',
      payloadHash: 'h',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Bet,
      money: brl('1.00'),
      referenceExternalTransactionId: undefined,
      correlationId: undefined,
      createdAt: T0,
      status: Status.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: T0,
      resultBalance: brl('99.00'),
      referenceAttempts: 0,
      nextReferenceCheckAt: undefined,
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
  });
});

describe('WagerTransaction domain queries', () => {
  test('affectsBalance is false only for LOSS', () => {
    expect(wager(wallet, Kind.Loss, '0').affectsBalance()).toBe(false);
    expect(wager(wallet, Kind.Bet, '1.00').affectsBalance()).toBe(true);
  });

  test('requiresReference for REFUND and ROLLBACK only', () => {
    expect(
      wager(wallet, Kind.Refund, '1.00', { referenceExternalTransactionId: 'b' }).requiresReference(),
    ).toBe(true);
    expect(wager(wallet, Kind.Win, '1.00').requiresReference()).toBe(false);
  });

  test('ledger direction per kind; ROLLBACK inverts its reference', () => {
    const bet = wager(wallet, Kind.Bet, '1.00');
    const win = wager(wallet, Kind.Win, '1.00');
    const refund = wager(wallet, Kind.Refund, '1.00', { referenceExternalTransactionId: 'b' });
    const rollback = wager(wallet, Kind.Rollback, '1.00', { referenceExternalTransactionId: 'b' });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow();
    expect(() => wager(wallet, Kind.Loss, '0').ledgerDirectionFor()).toThrow();
  });

  test('matchesPayload compares the stored hash', () => {
    const tx = wager(wallet, Kind.Bet, '1.00', { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  test('createOpening is internal, PROCESSED and credits', () => {
    const tx = WagerTransaction.createOpening({
      id: id(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('100.00'),
      at: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.status).toBe(Status.Processed);
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
