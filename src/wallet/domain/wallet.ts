import { DomainError, InvariantViolationError } from '../../shared/domain/errors';
import { CurrencyMismatchError, Money } from '../../shared/money/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InsufficientFundsError extends DomainError {
  constructor(walletId: string) {
    super('INSUFFICIENT_FUNDS', `Insufficient funds in wallet ${walletId}`);
  }
}

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Saldo inicial > 0 gera o lançamento de abertura com `walletVersion = 1`. */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative())
      throw new InvariantViolationError('Initial balance must not be negative');

    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    const openingEntry = initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          walletVersion: 1,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          createdAt: at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) throw new InsufficientFundsError(this.id);
    return this.apply(LedgerDirection.Debit, money, transactionId, entryId, at);
  }

  credit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, entryId, at);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    entryId: string,
    at: Date,
  ): WalletLedgerEntry {
    if (!money.isPositive()) throw new InvariantViolationError('Movement amount must be positive');
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      walletVersion: this._version + 1,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
