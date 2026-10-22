import { NotFoundError, ValidationError } from '../../shared/application/errors';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { WalletRepository } from './ports';

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

export class WalletNotFoundError extends NotFoundError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
  }
}

export async function requireWallet(wallets: WalletRepository, walletId: string): Promise<Wallet> {
  const wallet = await wallets.findById(walletId);
  if (!wallet) throw new WalletNotFoundError(walletId);
  return wallet;
}

export interface LedgerPageResult {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

// Cursor opaco: base64url de {"v": wallet_version do último item}; estável porque o ledger é append-only.
function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const { v } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) return v;
  } catch {}
  throw new ValidationError('Invalid ledger cursor');
}

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  getWallet(walletId: string): Promise<Wallet> {
    return this.uow.run(({ wallets }) => requireWallet(wallets, walletId), { readOnly: true });
  }

  listLedger(
    walletId: string,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<LedgerPageResult> {
    const beforeVersion = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    return this.uow.run(
      async ({ wallets, ledger }) => {
        await requireWallet(wallets, walletId);
        const { entries, hasMore } = await ledger.listByWallet(walletId, {
          beforeVersion,
          limit: page.limit,
        });
        const last = entries.at(-1);
        return { entries, nextCursor: hasMore && last ? encodeCursor(last.walletVersion) : null };
      },
      { readOnly: true },
    );
  }
}
