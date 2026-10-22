import { InboxMessage } from '../../messaging/domain/inbox-message';
import {
  ApplicationError,
  ConflictError,
  TransientError,
  UniqueConstraintError,
} from '../../shared/application/errors';
import type { Failpoints } from '../../shared/application/failpoints';
import type { Metrics, ProcessingOutcome } from '../../shared/application/metrics';
import type { TransactionScope, UnitOfWork } from '../../shared/application/unit-of-work';
import { addMs } from '../../shared/domain/backoff';
import type { Clock, IdGenerator } from '../../shared/domain/ports';
import type { Money } from '../../shared/money/money';
import { wagerPayloadHash } from '../domain/payload-hash';
import { applyWager } from '../domain/wager-applier';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { recordWagerEffects } from './wager-effects';

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  /** Validado pelo domínio (`KIND_NOT_ALLOWED` para OPENING). */
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

export interface ProcessContext {
  channel: 'http' | 'sqs';
  correlationId: string;
  causationId?: string | undefined;
  inbox?: { consumerName: string; messageId: string } | undefined;
}

export type ProcessOutcome =
  | { type: 'new'; transaction: WagerTransaction }
  | { type: 'replay'; transaction: WagerTransaction }
  | { type: 'duplicate_message' };

export interface ProcessWagerSettings {
  lockTimeoutMs: number;
  pendingReferenceBaseMs: number;
  maxReferenceAttempts: number;
  /** Tentativas para conflitos transitórios de concorrência (lock, deadlock, corrida de unicidade). */
  maxAttempts: number;
}

export class WalletNotFoundForWagerError extends ApplicationError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', 'unprocessable', `Wallet ${walletId} not found`);
  }
}

export class InboxPayloadMismatchError extends ApplicationError {
  constructor(messageId: string) {
    super(
      'INBOX_PAYLOAD_MISMATCH',
      'conflict',
      `Message ${messageId} was already received with another payload`,
    );
  }
}

// Corrida entre requisições iguais: a próxima tentativa encontra a linha vencedora (replay ou conflito).
const IDENTITY_CONSTRAINTS = new Set(['wager_tx_idempotency_key_unique', 'wager_tx_external_id_unique']);
const IDEMPOTENCY_CONFLICTS = new Set(['IDEMPOTENCY_KEY_REUSED', 'EXTERNAL_TRANSACTION_ID_REUSED']);

const RETRY_BASE_MS = 20;

export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly failpoints: Failpoints,
    private readonly metrics: Metrics,
    private readonly settings: ProcessWagerSettings,
  ) {}

  /** Único caminho de escrita para HTTP e SQS. */
  async execute(command: WagerCommand, idempotencyKey: string, ctx: ProcessContext): Promise<ProcessOutcome> {
    const payloadHash = wagerPayloadHash({ ...command, money: command.money.toJSON() });
    const build = (): WagerTransaction =>
      WagerTransaction.create({
        ...command,
        id: this.ids.next(),
        kind: command.kind as WagerTransactionKind,
        idempotencyKey,
        payloadHash,
        correlationId: ctx.correlationId,
        createdAt: this.clock.now(),
      });
    const { kind } = build(); // payload inválido falha antes de abrir transação
    const startedAt = performance.now();
    const observe = (outcome: ProcessingOutcome) =>
      this.metrics.wagerProcessingDuration(
        { kind, channel: ctx.channel, outcome },
        (performance.now() - startedAt) / 1_000,
      );

    try {
      const outcome = await this.withRetries(() =>
        this.uow.run((scope) => this.attempt(scope, build(), ctx), {
          lockTimeoutMs: this.settings.lockTimeoutMs,
        }),
      );
      switch (outcome.type) {
        case 'new':
          this.metrics.wagerTransaction({ kind, status: outcome.transaction.status, channel: ctx.channel });
          observe('new');
          break;
        case 'replay':
          this.metrics.idempotentReplay(ctx.channel);
          observe('replay');
          break;
        case 'duplicate_message':
          this.metrics.inboxDuplicate(ctx.inbox?.consumerName ?? 'unknown');
          observe('duplicate');
          break;
      }
      return outcome;
    } catch (error) {
      if (error instanceof ConflictError && IDEMPOTENCY_CONFLICTS.has(error.code)) {
        this.metrics.idempotencyConflict(error.code);
      }
      observe('error');
      throw error;
    }
  }

  private async withRetries<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof TransientError && error.code === 'LOCK_TIMEOUT')
          this.metrics.lockConflict(error.reason);
        if (attempt >= this.settings.maxAttempts || !isRetryable(error)) throw error;
        this.metrics.processingRetry(
          'process_wager',
          error instanceof TransientError ? error.reason : 'identity_race',
        );
        await Bun.sleep(RETRY_BASE_MS * attempt + Math.random() * RETRY_BASE_MS);
      }
    }
  }

  private async attempt(
    scope: TransactionScope,
    tx: WagerTransaction,
    ctx: ProcessContext,
  ): Promise<ProcessOutcome> {
    const at = tx.createdAt;

    if (ctx.inbox) {
      const message = InboxMessage.receive({ ...ctx.inbox, payloadHash: tx.payloadHash, receivedAt: at });
      message.markProcessed(at);
      if (!(await scope.inbox.insertIfAbsent(message))) {
        const received = await scope.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (received && !received.matchesPayload(tx.payloadHash)) {
          throw new InboxPayloadMismatchError(ctx.inbox.messageId);
        }
        return { type: 'duplicate_message' };
      }
    }

    const wallet = await scope.wallets.lockById(tx.walletId);
    if (!wallet) throw new WalletNotFoundForWagerError(tx.walletId);

    const existing = await scope.transactions.findByIdempotencyKey(tx.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(tx.payloadHash)) {
        throw new ConflictError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with another payload',
        );
      }
      return { type: 'replay', transaction: existing };
    }
    if (await scope.transactions.findByExternalId(tx.providerId, tx.externalTransactionId)) {
      throw new ConflictError(
        'EXTERNAL_TRANSACTION_ID_REUSED',
        `externalTransactionId ${tx.externalTransactionId} was already used with another Idempotency-Key`,
      );
    }

    const reference = tx.referenceExternalTransactionId
      ? await scope.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const expectedVersion = wallet.version;
    const outcome = applyWager(tx, wallet, {
      reference,
      referenceAlreadyReversed: reference
        ? await scope.transactions.hasProcessedReversal(reference.id)
        : false,
      ledgerEntryId: this.ids.next(),
      at,
      nextReferenceCheckAt: addMs(at, this.settings.pendingReferenceBaseMs),
      maxReferenceAttempts: this.settings.maxReferenceAttempts,
    });

    await scope.transactions.insert(tx);
    await recordWagerEffects(scope, {
      transaction: tx,
      wallet,
      expectedVersion,
      outcome,
      eventContext: () => ({
        eventId: this.ids.next(),
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        occurredAt: at,
      }),
    });

    this.failpoints.hit('process.beforeCommit');
    return { type: 'new', transaction: tx };
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof UniqueConstraintError) return IDENTITY_CONSTRAINTS.has(error.constraint ?? '');
  return error instanceof TransientError && error.code === 'LOCK_TIMEOUT';
}
