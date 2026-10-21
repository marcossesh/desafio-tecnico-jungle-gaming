import { DomainError, InvariantViolationError } from '../../shared/domain/errors';
import type { Money } from '../../shared/money/money';
import { LedgerDirection, oppositeDirection } from '../../wallet/domain/ledger-direction';
import type { FailureCode } from './failure-code';
import { canonicalHash } from './payload-hash';
import {
  REVERSAL_KINDS,
  TERMINAL_STATUSES,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction-kind';

export const INTERNAL_PROVIDER_ID = 'internal';

export class InvalidWagerTransactionError extends DomainError {}

export class InvalidTransactionStateError extends InvariantViolationError {}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  correlationId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Saldo da wallet observado quando a transação chegou ao estado atual (usado no replay). */
  resultBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | undefined;
}

/**
 * Transições válidas:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 *   PROCESSED, REJECTED, FAILED são terminais.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id no provedor — não o id interno */
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const fail = (code: string, message: string) => new InvalidWagerTransactionError(code, message);

    if (props.kind === WagerTransactionKind.Opening) {
      throw fail('KIND_NOT_ALLOWED', 'OPENING is internal and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw fail('VALIDATION_ERROR', `Unknown kind "${String(props.kind)}"`);
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw fail('VALIDATION_ERROR', `providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    for (const field of [
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'roundId',
      'gameId',
    ] as const) {
      if (!props[field]) throw fail('VALIDATION_ERROR', `${field} is required`);
    }
    if (REVERSAL_KINDS.has(props.kind) && !props.referenceExternalTransactionId) {
      throw fail('VALIDATION_ERROR', `${props.kind} requires referenceExternalTransactionId`);
    }
    const amountOk =
      props.kind === WagerTransactionKind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!amountOk) throw fail('INVALID_MONEY', `Invalid amount for ${props.kind}`);

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId || undefined,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Crédito interno de abertura, já PROCESSED. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    correlationId?: string | undefined;
    at: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) throw new InvariantViolationError('Opening amount must be positive');
    const tx = new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      `opening:${props.walletId}`,
      `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      canonicalHash({ walletId: props.walletId, money: props.money.toJSON() }),
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.correlationId,
      props.at,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
    tx.markProcessed(undefined, props.money, props.at);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt && new Date(state.processedAt),
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceCheckAt && new Date(state.nextReferenceCheckAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  markProcessed(referenceTransactionId: string | undefined, resultBalance: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvariantViolationError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  markPendingReference(nextCheckAt: Date, observedBalance: Money): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference from ${this._status}`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._resultBalance = observedBalance;
    this._nextReferenceCheckAt = nextCheckAt;
  }

  recordReferenceMiss(nextCheckAt: Date, observedBalance: Money): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`recordReferenceMiss from ${this._status}`);
    }
    this._referenceAttempts += 1;
    this._resultBalance = observedBalance;
    this._nextReferenceCheckAt = nextCheckAt;
  }

  reject(code: FailureCode, observedBalance: Money | undefined): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new InvariantViolationError('ROLLBACK direction requires its reference');
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not affect balance');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `${transition} on terminal transaction ${this.id} (${this._status})`,
      );
    }
  }
}
