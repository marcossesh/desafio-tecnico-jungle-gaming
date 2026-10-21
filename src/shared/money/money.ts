import { DomainError } from '../domain/errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
// numeric(20,2): 18 dígitos inteiros
const MAX_MINOR = 10n ** 20n - 1n;
const AMOUNT_RE = /^(0|[1-9]\d{0,17})(?:\.(\d{1,2}))?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class Money {
  private constructor(
    private readonly minor: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Contrato de entrada: string decimal não negativa, até 2 casas, sem arredondamento. */
  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) throw new InvalidMoneyError('Money must be an object');
    const { amount, currency } = props;
    if (typeof amount !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    const match = AMOUNT_RE.exec(amount);
    if (!match) throw new InvalidMoneyError(`Invalid amount "${amount}"`);
    const [, units = '0', fraction = ''] = match;
    const minor = BigInt(units) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
    return Money.ofMinor(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.ofMinor(0n, currency);
  }

  /** Uso interno; aceita negativo (ex.: `negate`). */
  static ofMinor(minor: bigint, currency: string): Money {
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}"`);
    }
    if (minor > MAX_MINOR || minor < -MAX_MINOR) throw new InvalidMoneyError('Amount out of range');
    return new Money(minor, currency);
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  get amount(): string {
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const units = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${this.minor < 0n ? '-' : ''}${units}.${fraction}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return Money.ofMinor(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
