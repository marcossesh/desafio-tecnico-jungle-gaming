import { InboxMessage } from '../../messaging/domain/inbox-message';
import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import {
  ApplicationError,
  ConflictError,
  TransientError,
  UniqueConstraintError,
} from '../../shared/application/errors';
import type { Failpoints } from '../../shared/application/failpoints';
import type { TransactionScope, UnitOfWork } from '../../shared/application/unit-of-work';
import { addMs } from '../../shared/domain/backoff';
import type { Clock, IdGenerator } from '../../shared/domain/ports';
import type { Money } from '../../shared/money/money';
import type { Wallet } from '../../wallet/domain/wallet';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { wagerPayloadHash } from '../domain/payload-hash';
import { applyWager, type WagerOutcome } from '../domain/wager-applier';
import { WagerTransaction } from '../domain/wager-transaction';
import { type WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction-kind';

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

const RETRY_BASE_MS = 20;

export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly failpoints: Failpoints,
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
    build(); // payload inválido falha antes de abrir transação

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((scope) => this.attempt(scope, build(), ctx), {
          lockTimeoutMs: this.settings.lockTimeoutMs,
        });
      } catch (error) {
        if (attempt >= this.settings.maxAttempts || !isRetryable(error)) throw error;
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
    if (outcome.status === WagerTransactionStatus.Processed && outcome.entry) {
      await scope.ledger.insert(outcome.entry);
      await scope.wallets.saveBalance(wallet, expectedVersion);
    }
    await scope.outbox.add(this.events(tx, wallet, outcome, ctx, at).map((e) => OutboxMessage.enqueue(e)));
    if (outcome.status === WagerTransactionStatus.Processed) {
      await scope.transactions.wakeDependents(tx.walletId, tx.providerId, tx.externalTransactionId, at);
    }

    this.failpoints.hit('process.beforeCommit');
    return { type: 'new', transaction: tx };
  }

  private events(
    tx: WagerTransaction,
    wallet: Wallet,
    outcome: WagerOutcome,
    ctx: ProcessContext,
    at: Date,
  ): IntegrationEvent<unknown>[] {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: at,
    });
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        return outcome.entry
          ? [
              WagerTransactionProcessed.from(tx, context()),
              WalletBalanceChanged.from(wallet, outcome.entry, context()),
            ]
          : [WagerTransactionProcessed.from(tx, context())];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(tx, context())];
      case WagerTransactionStatus.PendingReference:
        return [WagerTransactionPendingReference.from(tx, context())];
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof UniqueConstraintError) return IDENTITY_CONSTRAINTS.has(error.constraint ?? '');
  return error instanceof TransientError && error.code === 'LOCK_TIMEOUT';
}
