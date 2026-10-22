import { expect } from 'bun:test';
import type { SQL } from 'bun';

/** Invariante final de todo teste: saldo materializado = saldo reconstruído pelo ledger. */
export async function assertLedgerConsistent(sql: SQL): Promise<void> {
  const divergent = await sql`
    SELECT w.id, w.balance, w.version, s.calculated, s.last_version, s.last_after
      FROM wallets w
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) AS calculated,
               max(wallet_version) AS last_version,
               (SELECT balance_after FROM wallet_ledger_entries
                 WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1) AS last_after
          FROM wallet_ledger_entries WHERE wallet_id = w.id
      ) s ON true
     WHERE w.balance <> s.calculated
        OR w.version <> COALESCE(s.last_version, 1)
        OR w.balance <> COALESCE(s.last_after, 0)`;
  expect(divergent).toEqual([]);
}

/** Movimento válido escrito em SQL cru (BET/WIN processado + lançamento + saldo), para montar cenários. */
export async function applyEntry(
  sql: SQL,
  walletId: string,
  direction: 'CREDIT' | 'DEBIT',
  amount: string,
): Promise<string> {
  const transactionId = Bun.randomUUIDv7();
  const entryId = Bun.randomUUIDv7();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, processed_at, created_at, updated_at)
      SELECT ${transactionId}, 'provider-test', ${`ext-${transactionId}`}, ${`key-${transactionId}`}, repeat('a', 64),
             id, player_id, 'round-1', 'game-1', ${direction === 'DEBIT' ? 'BET' : 'WIN'}, ${amount}::numeric,
             currency, 'PROCESSED', now(), now(), now()
        FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    await tx`
      INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
      SELECT ${entryId}, id, ${transactionId}, version + 1, ${direction}, ${amount}::numeric, currency, balance,
             CASE WHEN ${direction} = 'CREDIT' THEN balance + ${amount}::numeric ELSE balance - ${amount}::numeric END,
             now()
        FROM wallets WHERE id = ${walletId}`;
    await tx`
      UPDATE wallets w SET balance = e.balance_after, version = e.wallet_version, updated_at = now()
        FROM wallet_ledger_entries e WHERE e.id = ${entryId} AND w.id = e.wallet_id`;
  });
  return transactionId;
}
