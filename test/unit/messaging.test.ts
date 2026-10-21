import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/wagering/domain/events';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { applyWager } from '../../src/wagering/domain/wager-applier';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-kind';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { applyCtx, id, Kind, openWallet, processed, T0, wager } from './fixtures';

const ctx = () => ({ eventId: id(), correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T0 });

describe('integration events', () => {
  test('WalletBalanceChanged carries MoneyProps, never Money instances', () => {
    const wallet = openWallet('100.00');
    const tx = wager(wallet, Kind.Bet, '25.00');
    const outcome = applyWager(tx, wallet, applyCtx());
    if (outcome.status !== WagerTransactionStatus.Processed || !outcome.entry) throw new Error('unreachable');

    const json = WalletBalanceChanged.from(wallet, outcome.entry, ctx()).toJSON();
    expect(json).toEqual({
      eventId: expect.any(String),
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: T0.toISOString(),
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: tx.id,
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('transaction events are keyed by transaction and partitioned by wallet', () => {
    const wallet = openWallet('100.00');
    const tx = processed(wallet, Kind.Bet, '10.00');
    const event = WagerTransactionProcessed.from(tx, ctx());
    expect(event.aggregateId).toBe(tx.id);
    expect(event.partitionKey).toBe(wallet.id);
    expect(event.toJSON().data.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
  });

  test('WagerTransactionRejected exposes the failure code', () => {
    const wallet = openWallet('1.00');
    const tx = processed(wallet, Kind.Bet, '10.00');
    expect(WagerTransactionRejected.from(tx, ctx()).toJSON().data.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
  });

  test('WagerTransactionPendingReference exposes the missing reference', () => {
    const wallet = openWallet('1.00');
    const tx = processed(wallet, Kind.Refund, '1.00', { referenceExternalTransactionId: 'bet-1' });
    const data = WagerTransactionPendingReference.from(tx, ctx()).toJSON().data;
    expect(data.referenceExternalTransactionId).toBe('bet-1');
    expect(data.nextCheckAt).toBe(tx.nextReferenceCheckAt?.toISOString() ?? null);
  });

  test('event data is frozen', () => {
    const wallet = openWallet('100.00');
    const event = WagerTransactionProcessed.from(processed(wallet, Kind.Bet, '1.00'), ctx());
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  const event = () => WagerTransactionProcessed.from(processed(openWallet('10.00'), Kind.Bet, '1.00'), ctx());

  test('enqueue uses eventId as id and is due immediately', () => {
    const e = event();
    const msg = OutboxMessage.enqueue(e);
    expect(msg.id).toBe(e.eventId);
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.payload).toEqual({ ...e.toJSON() });
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
  });

  test('scheduleRetry backs off exponentially up to the cap', () => {
    const msg = OutboxMessage.enqueue(event());
    const policy = { baseMs: 1_000, capMs: 5_000 };
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      msg.scheduleRetry(T0, policy);
      delays.push(msg.nextAttemptAt.getTime() - T0.getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(msg.attempts).toBe(5);
    expect(msg.isDue(T0)).toBe(false);
    expect(msg.isDue(new Date(T0.getTime() + 5_000))).toBe(true);
  });

  test('published messages are no longer pending and cannot be published twice', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(T0)).toBe(false);
    expect(() => msg.markPublished(T0)).toThrow();
  });
});

describe('InboxMessage', () => {
  test('receive → markProcessed once', () => {
    const msg = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-transactions',
      payloadHash: 'h',
      receivedAt: T0,
    });
    expect(msg.isProcessed()).toBe(false);
    expect(msg.matchesPayload('h')).toBe(true);
    msg.markProcessed(T0);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(T0)).toThrow();
  });
});
