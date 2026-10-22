// Repositórios + unit of work contra Postgres real: mapeamento ida e volta, update condicional e erros PG.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';
import {
  ConcurrencyConflictError,
  TransientError,
  UniqueConstraintError,
} from '../../src/shared/application/errors';
import { MikroOrmUnitOfWork } from '../../src/shared/infra/database/mikro-orm-unit-of-work';
import { createOrm } from '../../src/shared/infra/database/orm';
import { Money } from '../../src/shared/money/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind';
import { Wallet } from '../../src/wallet/domain/wallet';
import { appRoleUrl, createTestDatabase, type TestDatabase } from '../support/database';
import { failure } from '../support/failure';
import { assertLedgerConsistent } from '../support/ledger';

let db: TestDatabase;
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await createOrm({ clientUrl: appRoleUrl(db.url), poolMax: 4 });
  uow = new MikroOrmUnitOfWork(orm);
});

afterAll(async () => {
  await assertLedgerConsistent(db.sql);
  await orm.close();
  await db.drop();
});

const id = () => Bun.randomUUIDv7();
const at = new Date('2026-07-29T15:00:00.123Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function persistedWallet(balance = '0.00'): Promise<Wallet> {
  const openingTransactionId = id();
  const { wallet, openingEntry } = Wallet.open({
    id: id(),
    playerId: id(),
    initialBalance: brl(balance),
    openingTransactionId,
    openingEntryId: id(),
    at,
  });
  await uow.run(async ({ wallets, transactions, ledger }) => {
    await wallets.insert(wallet);
    if (!openingEntry) return;
    await transactions.insert(
      WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: wallet.balance,
        at,
      }),
    );
    await ledger.insert(openingEntry);
  });
  return wallet;
}

function wager(wallet: Wallet, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${id()}`;
  return WagerTransaction.create({
    id: id(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'f'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    correlationId: 'corr-1',
    createdAt: at,
    ...overrides,
  });
}

describe('wallet and ledger repositories', () => {
  test('a wallet round-trips through the mapper', async () => {
    const wallet = await persistedWallet('12.34');
    const loaded = await uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(loaded).toEqual(wallet);
    expect(await uow.run(({ wallets }) => wallets.findById(id()))).toBeUndefined();
  });

  test('saveBalance applies a locked debit and rejects a stale expected version', async () => {
    const wallet = await persistedWallet('100.00');
    const transaction = wager(wallet, { money: brl('40.00') });

    await uow.run(async ({ wallets, transactions, ledger }) => {
      const locked = await wallets.lockById(wallet.id);
      if (!locked) throw new Error('wallet not found');
      const expectedVersion = locked.version;
      const entry = locked.debit(transaction.money, transaction.id, id(), at);
      transaction.markProcessed(undefined, locked.balance, at);
      await transactions.insert(transaction);
      await ledger.insert(entry);
      await wallets.saveBalance(locked, expectedVersion);
    });

    const reloaded = await uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(reloaded?.balance).toEqual(brl('60.00'));
    expect(reloaded?.version).toBe(2);

    const stale = Wallet.rehydrate({ ...wallet, balance: brl('1.00'), version: 2, updatedAt: at });
    const error = await failure(uow.run(({ wallets }) => wallets.saveBalance(stale, 1)));
    expect(error).toBeInstanceOf(ConcurrencyConflictError);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', reason: 'version_conflict', kind: 'transient' });
  });

  test('ledger pages and summary are computed from the persisted chain', async () => {
    const wallet = await persistedWallet('50.00');
    await uow.run(async ({ wallets, transactions, ledger }) => {
      const locked = await wallets.lockById(wallet.id);
      if (!locked) throw new Error('wallet not found');
      for (const amount of ['5.00', '7.50']) {
        const tx = wager(locked, { money: brl(amount) });
        const expectedVersion = locked.version;
        const entry = locked.debit(tx.money, tx.id, id(), at);
        tx.markProcessed(undefined, locked.balance, at);
        await transactions.insert(tx);
        await ledger.insert(entry);
        await wallets.saveBalance(locked, expectedVersion);
      }
    });

    const { page, rest, summary } = await uow.run(async ({ ledger }) => ({
      page: await ledger.listByWallet(wallet.id, { limit: 2 }),
      rest: await ledger.listByWallet(wallet.id, { beforeVersion: 2, limit: 2 }),
      summary: await ledger.summarize(wallet.id, 'BRL'),
    }));
    expect(page.entries.map((e) => e.walletVersion)).toEqual([3, 2]);
    expect(page.hasMore).toBe(true);
    expect(page.entries[0]?.balanceAfter).toEqual(brl('37.50'));
    expect(rest.entries.map((e) => e.walletVersion)).toEqual([1]);
    expect(rest.hasMore).toBe(false);
    expect(summary).toEqual({
      checkedEntries: 3,
      calculatedBalance: brl('37.50'),
      lastBalanceAfter: brl('37.50'),
      lastVersion: 3,
      chainBreaks: 0,
    });
  });
});

describe('wager transaction repository', () => {
  test('insert, update and the three lookups return the same domain state', async () => {
    const wallet = await persistedWallet('0.00');
    const transaction = wager(wallet, { kind: WagerTransactionKind.Loss, money: brl('0.00') });
    await uow.run(({ transactions }) => transactions.insert(transaction));

    const loaded = await uow.run(({ transactions }) => transactions.findById(transaction.id));
    expect(loaded).toEqual(transaction);

    const refund = wager(wallet, {
      externalTransactionId: 'ext-refund',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-missing',
      correlationId: undefined,
    });
    refund.markPendingReference(new Date(at.getTime() + 2_000), brl('0.00'));
    await uow.run(({ transactions }) => transactions.insert(refund));
    refund.recordReferenceMiss(new Date(at.getTime() + 4_000), brl('0.00'));
    await uow.run(({ transactions }) => transactions.update(refund, new Date()));

    const byKey = await uow.run(({ transactions }) =>
      transactions.findByIdempotencyKey('provider-a:ext-refund'),
    );
    const byExternal = await uow.run(({ transactions }) =>
      transactions.findByExternalId('provider-a', 'ext-refund'),
    );
    expect(byKey).toEqual(refund);
    expect(byExternal).toEqual(refund);
    expect(byKey?.referenceAttempts).toBe(1);
  });
});

describe('inbox repository', () => {
  test('insertIfAbsent records a message once per consumer', async () => {
    const message = InboxMessage.receive({
      consumerName: 'wager-consumer',
      messageId: `msg-${id()}`,
      payloadHash: 'c'.repeat(64),
      receivedAt: at,
    });
    expect(await uow.run(({ inbox }) => inbox.insertIfAbsent(message))).toBe(true);
    expect(await uow.run(({ inbox }) => inbox.insertIfAbsent(message))).toBe(false);
    expect(await uow.run(({ inbox }) => inbox.find(message.consumerName, message.messageId))).toEqual(
      message,
    );
  });
});

describe('unit of work', () => {
  test('a failure inside the work rolls back every write', async () => {
    const wallet = Wallet.open({
      id: id(),
      playerId: id(),
      initialBalance: brl('0.00'),
      openingTransactionId: id(),
      openingEntryId: id(),
      at,
    }).wallet;
    const error = await failure(
      uow.run(async ({ wallets }) => {
        await wallets.insert(wallet);
        throw new Error('boom');
      }),
    );
    expect(error).toMatchObject({ message: 'boom' });
    expect(await uow.run(({ wallets }) => wallets.findById(wallet.id))).toBeUndefined();
  });

  test('unique violations carry the constraint name', async () => {
    const wallet = await persistedWallet();
    const duplicate = Wallet.rehydrate({
      id: id(),
      playerId: wallet.playerId,
      currency: 'BRL',
      balance: brl('0.00'),
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    const error = await failure(uow.run(({ wallets }) => wallets.insert(duplicate)));
    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error).toMatchObject({ constraint: 'wallets_player_currency_unique' });
  });

  test('waiting longer than lockTimeoutMs on a locked wallet is a transient LOCK_TIMEOUT', async () => {
    const wallet = await persistedWallet();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      signalLocked();
      await released;
    });
    await locked;

    const startedAt = performance.now();
    const error = await failure(
      uow.run(({ wallets }) => wallets.lockById(wallet.id), { lockTimeoutMs: 150 }),
    );
    const waited = performance.now() - startedAt;
    release();
    await holder;

    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', reason: 'lock_timeout' });
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(await uow.run(({ wallets }) => wallets.lockById(wallet.id), { lockTimeoutMs: 150 })).toEqual(
      wallet,
    );
  });

  test('repeatable read read-only transactions reject writes', async () => {
    const wallet = Wallet.open({
      id: id(),
      playerId: id(),
      initialBalance: brl('0.00'),
      openingTransactionId: id(),
      openingEntryId: id(),
      at,
    }).wallet;
    const error = await failure(
      uow.run(({ wallets }) => wallets.insert(wallet), { isolation: 'repeatable read', readOnly: true }),
    );
    expect(error).toMatchObject({ code: '25006' });
  });
});
