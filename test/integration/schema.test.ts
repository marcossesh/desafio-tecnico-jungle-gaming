// Invariantes provadas no banco com SQL cru, sem passar pela aplicação.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { runMigrations } from '../../src/shared/infra/migrator';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { failure } from '../support/failure';

const MIGRATIONS = [
  '0001_wallets',
  '0002_wager_transactions',
  '0003_wallet_ledger_entries',
  '0004_inbox_outbox',
  '0005_integrity_triggers',
  '0006_outbox_pending_seq_index',
];

type Row = Record<string, unknown>;

const uuid = () => crypto.randomUUID();
const now = new Date();

let db: TestDatabase;
let sql: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
});

afterAll(async () => {
  await db.drop();
});

function walletRow(overrides: Row = {}): Row {
  return {
    id: uuid(),
    player_id: uuid(),
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function wagerRow(wallet: Row, overrides: Row = {}): Row {
  const id = uuid();
  return {
    id,
    provider_id: 'provider-a',
    external_transaction_id: `ext-${id}`,
    idempotency_key: `idem-${id}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    status: 'PENDING',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function entryRow(wallet: Row, transaction: Row, overrides: Row = {}): Row {
  return {
    id: uuid(),
    wallet_id: wallet.id,
    transaction_id: transaction.id,
    wallet_version: 1,
    direction: 'CREDIT',
    amount: '10.00',
    currency: wallet.currency,
    balance_before: '0.00',
    balance_after: '10.00',
    created_at: now,
    ...overrides,
  };
}

const insert = (db: SQL, table: string, row: Row) => db`INSERT INTO ${db(table)} ${db(row)}`;

async function openWallet(balance = '100.00', overrides: Row = {}): Promise<Row> {
  const wallet = walletRow({ balance, ...overrides });
  await sql.begin(async (tx) => {
    await insert(tx, 'wallets', wallet);
    if (balance === '0.00') return;
    const opening = wagerRow(wallet, {
      provider_id: 'internal',
      kind: 'OPENING',
      round_id: null,
      game_id: null,
      amount: balance,
      status: 'PROCESSED',
      processed_at: now,
    });
    await insert(tx, 'wager_transactions', opening);
    await insert(
      tx,
      'wallet_ledger_entries',
      entryRow(wallet, opening, { amount: balance, balance_after: balance }),
    );
  });
  return wallet;
}

// Caminho feliz completo: transação processada + lançamento + saldo/version, como o use case fará.
async function post(
  wallet: Row,
  direction: 'CREDIT' | 'DEBIT',
  amount: string,
  overrides: Row = {},
): Promise<Row> {
  const transaction = wagerRow(wallet, {
    kind: direction === 'DEBIT' ? 'BET' : 'WIN',
    amount,
    status: 'PROCESSED',
    processed_at: now,
    ...overrides,
  });
  const entryId = uuid();
  await sql.begin(async (tx) => {
    await insert(tx, 'wager_transactions', transaction);
    await tx`
      INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
      SELECT ${entryId}, id, ${transaction.id}, version + 1, ${direction}, ${amount}::numeric, currency, balance,
             CASE WHEN ${direction} = 'CREDIT' THEN balance + ${amount}::numeric ELSE balance - ${amount}::numeric END,
             now()
        FROM wallets WHERE id = ${wallet.id}`;
    await tx`
      UPDATE wallets w SET balance = e.balance_after, version = e.wallet_version, updated_at = now()
        FROM wallet_ledger_entries e WHERE e.id = ${entryId} AND w.id = e.wallet_id`;
  });
  return transaction;
}

async function walletState(wallet: Row): Promise<{ balance: string; version: number }> {
  const [row] = await sql`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
  return row;
}

const violates = (constraint: string, errno = '23514') => ({ errno, constraint });
const invariant = (message: string) => ({ errno: '23000', message: expect.stringContaining(message) });

describe('migrations', () => {
  test('up → down → up on an empty database', async () => {
    const empty = await createTestDatabase({ migrated: false });
    try {
      const tables = async () =>
        (await empty.sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`).map(
          (r: { tablename: string }) => r.tablename,
        );
      const functions = async () =>
        (
          await empty.sql`
            SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' ORDER BY p.proname`
        ).map((r: { proname: string }) => r.proname);

      expect(await runMigrations(empty.url, 'up')).toEqual(MIGRATIONS);
      expect(await tables()).toEqual([
        'inbox_messages',
        'mikro_orm_migrations',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ]);
      expect(await functions()).toHaveLength(6);

      expect(await runMigrations(empty.url, 'down', { to: 0 })).toEqual([...MIGRATIONS].reverse());
      expect(await tables()).toEqual(['mikro_orm_migrations']);
      expect(await functions()).toEqual([]);

      expect(await runMigrations(empty.url, 'up')).toEqual(MIGRATIONS);
      expect(await runMigrations(empty.url, 'down')).toEqual(['0006_outbox_pending_seq_index']);
      expect(await runMigrations(empty.url, 'up')).toEqual(['0006_outbox_pending_seq_index']);
    } finally {
      await empty.drop();
    }
  });
});

describe('valid flows are accepted', () => {
  test('opening, bet, win, loss and refund keep balance, version and ledger chain in sync', async () => {
    const wallet = await openWallet('100.00');
    const bet = await post(wallet, 'DEBIT', '30.00');
    await post(wallet, 'CREDIT', '45.50');
    await insert(sql, 'wager_transactions', wagerRow(wallet, { kind: 'LOSS', amount: '0.00' }));
    await post(wallet, 'CREDIT', '30.00', {
      kind: 'REFUND',
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
    });

    expect(await walletState(wallet)).toEqual({ balance: '145.50', version: 4 });
    const chain = await sql`
      SELECT wallet_version, balance_before, balance_after FROM wallet_ledger_entries
       WHERE wallet_id = ${wallet.id} ORDER BY wallet_version`;
    expect(chain).toEqual([
      { wallet_version: 1, balance_before: '0.00', balance_after: '100.00' },
      { wallet_version: 2, balance_before: '100.00', balance_after: '70.00' },
      { wallet_version: 3, balance_before: '70.00', balance_after: '115.50' },
      { wallet_version: 4, balance_before: '115.50', balance_after: '145.50' },
    ]);
  });

  test('a wallet opened empty starts its chain at version 2 from zero', async () => {
    const wallet = await openWallet('0.00');
    await post(wallet, 'CREDIT', '5.00');
    expect(await walletState(wallet)).toEqual({ balance: '5.00', version: 2 });
  });

  test('non-terminal transactions can move through their lifecycle', async () => {
    const wallet = await openWallet();
    const pending = wagerRow(wallet, {
      kind: 'ROLLBACK',
      reference_external_transaction_id: 'ext-missing',
      status: 'PENDING_REFERENCE',
      next_reference_check_at: now,
    });
    await insert(sql, 'wager_transactions', pending);
    await sql`UPDATE wager_transactions SET reference_attempts = 1, updated_at = now() WHERE id = ${pending.id}`;
    await sql`
      UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', next_reference_check_at = NULL
       WHERE id = ${pending.id}`;
  });
});

describe('wallets', () => {
  test('balance cannot be negative', async () => {
    expect(await failure(insert(sql, 'wallets', walletRow({ balance: '-0.01' })))).toMatchObject(
      violates('wallets_balance_non_negative'),
    );
  });

  test('currency must be an ISO-like code', async () => {
    expect(await failure(insert(sql, 'wallets', walletRow({ currency: 'brl' })))).toMatchObject(
      violates('wallets_currency_format'),
    );
  });

  test('one wallet per player and currency', async () => {
    const wallet = await openWallet('0.00');
    expect(
      await failure(
        insert(sql, 'wallets', walletRow({ player_id: wallet.player_id, currency: wallet.currency })),
      ),
    ).toMatchObject(violates('wallets_player_currency_unique', '23505'));
  });

  test('a wallet starts at version 1', async () => {
    expect(await failure(insert(sql, 'wallets', walletRow({ version: 2 })))).toMatchObject(
      invariant('must start at version 1'),
    );
  });

  test('a wallet cannot be created with balance and no opening entry', async () => {
    expect(await failure(insert(sql, 'wallets', walletRow({ balance: '50.00' })))).toMatchObject(
      invariant('has no matching ledger entry'),
    );
  });

  test('balance cannot change without a ledger entry, even with the version bumped', async () => {
    const wallet = await openWallet();
    expect(
      await failure(sql`UPDATE wallets SET balance = 1000, version = version + 1 WHERE id = ${wallet.id}`),
    ).toMatchObject(invariant('has no matching ledger entry'));
    expect(await walletState(wallet)).toEqual({ balance: '100.00', version: 1 });
  });

  test('the check is deferred to commit: the entry may come after the balance update', async () => {
    const wallet = await openWallet();
    const win = wagerRow(wallet, { kind: 'WIN', status: 'PROCESSED', processed_at: now });
    await sql.begin(async (tx) => {
      await insert(tx, 'wager_transactions', win);
      await tx`UPDATE wallets SET balance = 110, version = 2 WHERE id = ${wallet.id}`;
      await insert(
        tx,
        'wallet_ledger_entries',
        entryRow(wallet, win, { wallet_version: 2, balance_before: '100.00', balance_after: '110.00' }),
      );
    });
    expect(await walletState(wallet)).toEqual({ balance: '110.00', version: 2 });

    const unbalanced = sql.begin(async (tx) => {
      await tx`UPDATE wallets SET balance = 90, version = 3 WHERE id = ${wallet.id}`;
      await tx`SELECT 1`;
    });
    expect(await failure(unbalanced)).toMatchObject(invariant('has no matching ledger entry'));
    expect(await walletState(wallet)).toEqual({ balance: '110.00', version: 2 });
  });

  test.each([
    ['version changes without balance change', 'version = version + 1'],
    ['balance changes without version change', 'balance = balance + 1'],
    ['version skips ahead', 'balance = balance + 1, version = version + 2'],
    ['version goes back', 'version = version - 1'],
  ])('%s is rejected', async (_name, assignment) => {
    const wallet = await openWallet();
    await post(wallet, 'DEBIT', '1.00');
    expect(
      await failure(sql.unsafe(`UPDATE wallets SET ${assignment} WHERE id = $1`, [wallet.id])),
    ).toMatchObject(invariant('version must advance by exactly one iff balance changes'));
  });

  test.each([
    ['player_id', `player_id = '${uuid()}'`],
    ['currency', `currency = 'USD'`],
    ['created_at', 'created_at = now()'],
  ])('%s is immutable', async (_column, assignment) => {
    const wallet = await openWallet('0.00');
    expect(
      await failure(sql.unsafe(`UPDATE wallets SET ${assignment} WHERE id = $1`, [wallet.id])),
    ).toMatchObject(invariant('identity columns are immutable'));
  });

  test('wallets cannot be deleted', async () => {
    const wallet = await openWallet('0.00');
    expect(await failure(sql`DELETE FROM wallets WHERE id = ${wallet.id}`)).toMatchObject(
      invariant('cannot be deleted'),
    );
  });
});

describe('wallet_ledger_entries', () => {
  test('entries cannot be updated, deleted or truncated', async () => {
    const wallet = await openWallet();
    expect(
      await failure(sql`UPDATE wallet_ledger_entries SET created_at = now() WHERE wallet_id = ${wallet.id}`),
    ).toMatchObject(invariant('append-only (UPDATE rejected)'));
    expect(
      await failure(sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}`),
    ).toMatchObject(invariant('append-only (DELETE rejected)'));
    expect(await failure(sql`TRUNCATE wallet_ledger_entries CASCADE`)).toMatchObject(
      invariant('append-only (TRUNCATE rejected)'),
    );
  });

  // Base: lançamento válido na v2 de uma wallet com saldo 100 na v1; cada caso quebra uma regra.
  test.each<[string, Row, Row]>([
    ['arithmetic does not add up', { balance_after: '115.00' }, violates('ledger_arithmetic')],
    ['amount is zero', { amount: '0.00', balance_after: '100.00' }, violates('ledger_amount_positive')],
    [
      'debit drives balance negative',
      { direction: 'DEBIT', amount: '100.01', balance_after: '-0.01' },
      violates('ledger_balance_after_non_negative'),
    ],
    ['currency differs from the wallet', { currency: 'USD' }, violates('ledger_wallet_currency_fk', '23503')],
    [
      'version reuses an existing one',
      { wallet_version: 1, balance_before: '0.00', balance_after: '10.00' },
      violates('ledger_wallet_version_unique', '23505'),
    ],
    [
      'balance_before breaks the chain',
      { balance_before: '90.00', balance_after: '100.00' },
      invariant('chain broken'),
    ],
    ['first entry of a funded wallet skips version 1', { wallet_version: 3 }, invariant('chain broken')],
  ])('%s', async (_name, overrides, expected) => {
    const wallet = await openWallet('100.00');
    const transaction = wagerRow(wallet, { kind: 'WIN', amount: '10.00' });
    await insert(sql, 'wager_transactions', transaction);
    const entry = entryRow(wallet, transaction, {
      wallet_version: 2,
      balance_before: '100.00',
      balance_after: '110.00',
      ...overrides,
    });
    expect(await failure(insert(sql, 'wallet_ledger_entries', entry))).toMatchObject(expected);
  });

  test('an entry cannot exist without the wallet advancing to its version', async () => {
    const wallet = await openWallet();
    const win = wagerRow(wallet, { kind: 'WIN', status: 'PROCESSED', processed_at: now });
    await insert(sql, 'wager_transactions', win);
    const entry = entryRow(wallet, win, {
      wallet_version: 2,
      balance_before: '100.00',
      balance_after: '110.00',
    });
    expect(await failure(insert(sql, 'wallet_ledger_entries', entry))).toMatchObject(
      invariant('has no matching wallet balance change'),
    );
  });

  test.each<[string, Row]>([
    ['LOSS', { kind: 'LOSS' }],
    ['REJECTED', { status: 'REJECTED', processed_at: null, failure_code: 'INSUFFICIENT_FUNDS' }],
    ['PENDING', { status: 'PENDING', processed_at: null }],
  ])('a %s transaction cannot have an entry', async (_name, overrides) => {
    const wallet = await openWallet();
    expect(await failure(post(wallet, 'CREDIT', '10.00', overrides))).toMatchObject(
      invariant('does not move balance'),
    );
    expect(await walletState(wallet)).toEqual({ balance: '100.00', version: 1 });
  });

  test('a pending reversal can get its entry before being marked PROCESSED in the same transaction', async () => {
    const wallet = await openWallet();
    const bet = await post(wallet, 'DEBIT', '30.00');
    const refund = wagerRow(wallet, {
      kind: 'REFUND',
      amount: '30.00',
      reference_external_transaction_id: bet.external_transaction_id,
      status: 'PENDING_REFERENCE',
      next_reference_check_at: now,
    });
    await insert(sql, 'wager_transactions', refund);
    await sql.begin(async (tx) => {
      await insert(
        tx,
        'wallet_ledger_entries',
        entryRow(wallet, refund, {
          wallet_version: 3,
          amount: '30.00',
          balance_before: '70.00',
          balance_after: '100.00',
        }),
      );
      await tx`UPDATE wallets SET balance = 100, version = 3 WHERE id = ${wallet.id}`;
      await tx`
        UPDATE wager_transactions
           SET status = 'PROCESSED', processed_at = now(), reference_transaction_id = ${bet.id},
               next_reference_check_at = NULL
         WHERE id = ${refund.id}`;
    });
    expect(await walletState(wallet)).toEqual({ balance: '100.00', version: 3 });
  });

  test('an entry must belong to a transaction of the same wallet', async () => {
    const wallet = await openWallet();
    const other = await openWallet('0.00');
    const foreign = wagerRow(other, { kind: 'WIN' });
    await insert(sql, 'wager_transactions', foreign);
    expect(
      await failure(
        insert(
          sql,
          'wallet_ledger_entries',
          entryRow(wallet, foreign, { wallet_version: 2, balance_before: '100.00', balance_after: '110.00' }),
        ),
      ),
    ).toMatchObject(violates('ledger_transaction_wallet_fk', '23503'));
  });

  test('a transaction has at most one entry per wallet', async () => {
    const wallet = await openWallet();
    const win = await post(wallet, 'CREDIT', '10.00');
    expect(
      await failure(
        insert(
          sql,
          'wallet_ledger_entries',
          entryRow(wallet, win, { wallet_version: 3, balance_before: '110.00', balance_after: '120.00' }),
        ),
      ),
    ).toMatchObject(violates('ledger_transaction_wallet_unique', '23505'));
  });
});

describe('wager_transactions', () => {
  test.each<[string, Row, string, string?]>([
    ['kind outside the enum', { kind: 'BONUS' }, 'wager_tx_kind_valid'],
    ['status outside the enum', { status: 'DONE' }, 'wager_tx_status_valid'],
    ['BET with zero amount', { amount: '0.00' }, 'wager_tx_amount_positive'],
    ['LOSS with negative amount', { kind: 'LOSS', amount: '-1.00' }, 'wager_tx_amount_positive'],
    ['REFUND without reference', { kind: 'REFUND' }, 'wager_tx_reversal_has_reference'],
    [
      'OPENING from an external provider',
      { kind: 'OPENING', round_id: null, game_id: null },
      'wager_tx_opening_internal',
    ],
    ['BET from the internal provider', { provider_id: 'internal' }, 'wager_tx_opening_internal'],
    ['BET without round', { round_id: null }, 'wager_tx_round_required'],
    ['PROCESSED without processed_at', { status: 'PROCESSED' }, 'wager_tx_processed_shape'],
    [
      'PROCESSED with failure code',
      { status: 'PROCESSED', processed_at: now, failure_code: 'INSUFFICIENT_FUNDS' },
      'wager_tx_processed_shape',
    ],
    ['REJECTED without failure code', { status: 'REJECTED' }, 'wager_tx_failure_code_required'],
    ['FAILED without failure code', { status: 'FAILED' }, 'wager_tx_failure_code_required'],
    [
      'PENDING_REFERENCE without next check',
      { kind: 'ROLLBACK', reference_external_transaction_id: 'ext-x', status: 'PENDING_REFERENCE' },
      'wager_tx_pending_reference_scheduled',
    ],
    [
      'PROCESSED reversal not linked to its reference',
      { kind: 'REFUND', reference_external_transaction_id: 'ext-x', status: 'PROCESSED', processed_at: now },
      'wager_tx_processed_reversal_linked',
    ],
    ['result balance without currency', { result_balance: '1.00' }, 'wager_tx_result_pair'],
    [
      'negative result balance',
      { result_balance: '-1.00', result_currency: 'BRL' },
      'wager_tx_result_balance_non_negative',
    ],
    ['negative reference attempts', { reference_attempts: -1 }, 'wager_tx_reference_attempts_non_negative'],
    ['unknown wallet', { wallet_id: uuid() }, 'wager_transactions_wallet_id_fkey', '23503'],
  ])('%s is rejected', async (_name, overrides, constraint, errno = '23514') => {
    const wallet = await openWallet('0.00');
    expect(await failure(insert(sql, 'wager_transactions', wagerRow(wallet, overrides)))).toMatchObject(
      violates(constraint, errno),
    );
  });

  test('idempotency key and (provider, external id) are unique', async () => {
    const wallet = await openWallet('0.00');
    const first = wagerRow(wallet);
    await insert(sql, 'wager_transactions', first);
    expect(
      await failure(
        insert(sql, 'wager_transactions', wagerRow(wallet, { idempotency_key: first.idempotency_key })),
      ),
    ).toMatchObject(violates('wager_tx_idempotency_key_unique', '23505'));
    expect(
      await failure(
        insert(
          sql,
          'wager_transactions',
          wagerRow(wallet, { external_transaction_id: first.external_transaction_id }),
        ),
      ),
    ).toMatchObject(violates('wager_tx_external_id_unique', '23505'));
  });

  test('a wallet has a single OPENING', async () => {
    const wallet = await openWallet('100.00');
    const second = wagerRow(wallet, {
      provider_id: 'internal',
      kind: 'OPENING',
      round_id: null,
      game_id: null,
    });
    expect(await failure(insert(sql, 'wager_transactions', second))).toMatchObject(
      violates('wager_tx_single_opening_unique', '23505'),
    );
  });

  test('a reference cannot be reversed twice', async () => {
    const wallet = await openWallet();
    const bet = await post(wallet, 'DEBIT', '30.00');
    const reversal = (kind: string) => ({
      kind,
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
    });
    await post(wallet, 'CREDIT', '30.00', reversal('REFUND'));
    expect(await failure(post(wallet, 'CREDIT', '30.00', reversal('ROLLBACK')))).toMatchObject(
      violates('wager_tx_single_reversal_unique', '23505'),
    );
    // uma reversão rejeitada da mesma referência continua auditável
    await insert(
      sql,
      'wager_transactions',
      wagerRow(wallet, {
        ...reversal('ROLLBACK'),
        status: 'REJECTED',
        failure_code: 'REFERENCE_ALREADY_REVERSED',
      }),
    );
    expect(await walletState(wallet)).toEqual({ balance: '100.00', version: 3 });
  });

  test.each(['PROCESSED', 'REJECTED', 'FAILED'])('%s transactions are immutable', async (status) => {
    const wallet = await openWallet('0.00');
    const terminal = wagerRow(wallet, {
      status,
      processed_at: status === 'PROCESSED' ? now : null,
      failure_code: status === 'PROCESSED' ? null : 'INTERNAL_ERROR',
    });
    await insert(sql, 'wager_transactions', terminal);
    expect(
      await failure(sql`UPDATE wager_transactions SET updated_at = now() WHERE id = ${terminal.id}`),
    ).toMatchObject(invariant('is terminal'));
  });

  test.each([
    ['amount', 'amount = 99'],
    ['kind', `kind = 'WIN'`],
    ['payload_hash', `payload_hash = '${'b'.repeat(64)}'`],
    ['idempotency_key', `idempotency_key = 'other'`],
    ['reference_external_transaction_id', `reference_external_transaction_id = 'ext-y'`],
  ])('%s of a pending transaction is immutable', async (_column, assignment) => {
    const wallet = await openWallet('0.00');
    const pending = wagerRow(wallet);
    await insert(sql, 'wager_transactions', pending);
    expect(
      await failure(sql.unsafe(`UPDATE wager_transactions SET ${assignment} WHERE id = $1`, [pending.id])),
    ).toMatchObject(invariant('business columns are immutable'));
  });

  test('transactions cannot be deleted', async () => {
    const wallet = await openWallet('0.00');
    const pending = wagerRow(wallet);
    await insert(sql, 'wager_transactions', pending);
    expect(await failure(sql`DELETE FROM wager_transactions WHERE id = ${pending.id}`)).toMatchObject(
      invariant('cannot be deleted'),
    );
  });
});

describe('inbox and outbox', () => {
  test('a message is recorded once per consumer', async () => {
    const message = {
      consumer_name: 'wager-consumer',
      message_id: uuid(),
      payload_hash: 'c'.repeat(64),
      received_at: now,
    };
    await insert(sql, 'inbox_messages', message);
    await insert(sql, 'inbox_messages', { ...message, consumer_name: 'other-consumer' });
    expect(await failure(insert(sql, 'inbox_messages', message))).toMatchObject(
      violates('inbox_messages_pkey', '23505'),
    );
  });

  test('outbox attempts cannot be negative and seq follows insertion order', async () => {
    const event = (overrides: Row = {}) => ({
      id: uuid(),
      aggregate_id: uuid(),
      partition_key: 'wallet-1',
      event_type: 'WalletBalanceChanged',
      event_version: 1,
      payload: JSON.stringify({ eventType: 'WalletBalanceChanged' }),
      occurred_at: now,
      next_attempt_at: now,
      ...overrides,
    });
    const first = event();
    const second = event();
    await insert(sql, 'outbox_messages', first);
    await insert(sql, 'outbox_messages', second);
    const [a, b] =
      await sql`SELECT seq FROM outbox_messages WHERE id IN ${sql([first.id, second.id])} ORDER BY seq`;
    expect(BigInt(b.seq)).toBeGreaterThan(BigInt(a.seq));
    expect(await failure(insert(sql, 'outbox_messages', event({ attempts: -1 })))).toMatchObject(
      violates('outbox_attempts_non_negative'),
    );
  });
});
