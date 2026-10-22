import type { Logger } from 'pino';
import { TransientError } from '../../shared/application/errors';
import type { Failpoints } from '../../shared/application/failpoints';
import type { Metrics } from '../../shared/application/metrics';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { addMs, type BackoffPolicy, exponentialBackoffMs } from '../../shared/domain/backoff';
import type { Clock, IdGenerator } from '../../shared/domain/ports';
import { Money } from '../../shared/money/money';
import { FailureCode } from '../domain/failure-code';
import { applyWager } from '../domain/wager-applier';
import { WagerTransactionStatus } from '../domain/wager-transaction-kind';
import type { ClaimedTransaction } from './ports';
import { recordWagerEffects } from './wager-effects';

export interface ReprocessSettings {
  batchSize: number;
  claimLeaseMs: number;
  backoff: BackoffPolicy;
  /** Re-verificações (e erros inesperados) antes de REFERENCE_NOT_FOUND / PROCESSING_FAILED. */
  maxReferenceAttempts: number;
  lockTimeoutMs: number;
}

type ItemResult = 'processed' | 'rejected' | 'stillPending' | 'skipped';

export interface ReprocessReport extends Record<ItemResult, number> {
  claimed: number;
  failed: number;
  errors: number;
}

export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly failpoints: Failpoints,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly settings: ReprocessSettings,
  ) {}

  /** Um ciclo do worker: reserva um lote e processa cada item na sua própria transação. */
  async runOnce(): Promise<ReprocessReport> {
    const now = this.clock.now();
    const claimed = await this.uow.run(({ transactions }) =>
      transactions.claimDuePendingReferences(
        now,
        addMs(now, this.settings.claimLeaseMs),
        this.settings.batchSize,
      ),
    );
    const report: ReprocessReport = {
      claimed: claimed.length,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      skipped: 0,
      failed: 0,
      errors: 0,
    };

    for (const item of claimed) {
      try {
        const { result, kind } = await this.process(item);
        report[result] += 1;
        if (result === 'processed' || result === 'rejected') {
          const status =
            result === 'processed' ? WagerTransactionStatus.Processed : WagerTransactionStatus.Rejected;
          this.metrics.wagerTransaction({ kind, status, channel: 'worker' });
        } else if (result === 'stillPending') {
          this.metrics.processingRetry('pending_reference', 'reference_missing');
        }
      } catch (error) {
        report.errors += 1;
        // transitório não gasta tentativa: o lease já reagendou o item
        if (error instanceof TransientError) {
          this.metrics.processingRetry('pending_reference', error.reason);
          if (error.code === 'LOCK_TIMEOUT') this.metrics.lockConflict(error.reason);
          continue;
        }
        this.logger.error(
          { err: error, transactionId: item.id, walletId: item.walletId },
          'pending reference failed',
        );
        this.metrics.processingRetry('pending_reference', 'unexpected_error');
        const failedKind = await this.recordError(item);
        if (failedKind) {
          report.failed += 1;
          this.metrics.wagerTransaction({
            kind: failedKind,
            status: WagerTransactionStatus.Failed,
            channel: 'worker',
          });
        }
      }
    }
    this.metrics.pendingReferences(
      await this.uow.run(({ transactions }) => transactions.countPendingReferences()),
    );
    return report;
  }

  private process(item: ClaimedTransaction): Promise<{ result: ItemResult; kind: string }> {
    return this.uow.run(
      async (scope) => {
        const at = this.clock.now();
        const wallet = await scope.wallets.lockById(item.walletId);
        const tx = await scope.transactions.lockById(item.id);
        if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) {
          return { result: 'skipped', kind: tx?.kind ?? 'unknown' };
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
          nextReferenceCheckAt: this.nextCheck(at, tx.referenceAttempts + 1),
          maxReferenceAttempts: this.settings.maxReferenceAttempts,
        });

        await scope.transactions.update(tx, at);
        await recordWagerEffects(scope, {
          transaction: tx,
          wallet,
          expectedVersion,
          outcome,
          eventContext: () => ({
            eventId: this.ids.next(),
            correlationId: tx.correlationId ?? tx.id,
            causationId: tx.id,
            occurredAt: at,
          }),
        });
        this.failpoints.hit('reprocess.beforeCommit');

        const results: Record<typeof outcome.status, ItemResult> = {
          [WagerTransactionStatus.Processed]: 'processed',
          [WagerTransactionStatus.Rejected]: 'rejected',
          [WagerTransactionStatus.PendingReference]: 'stillPending',
        };
        return { result: results[outcome.status], kind: tx.kind };
      },
      { lockTimeoutMs: this.settings.lockTimeoutMs },
    );
  }

  /** Erro inesperado consome uma tentativa; esgotadas, vira FAILED auditável. Retorna o kind se falhou de vez. */
  private recordError(item: ClaimedTransaction): Promise<string | undefined> {
    return this.uow.run(async ({ transactions }) => {
      const at = this.clock.now();
      const tx = await transactions.lockById(item.id);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;
      const exhausted = tx.referenceAttempts + 1 >= this.settings.maxReferenceAttempts;
      if (exhausted) tx.fail(FailureCode.ProcessingFailed);
      else {
        tx.recordReferenceMiss(
          this.nextCheck(at, tx.referenceAttempts + 1),
          tx.resultBalance ?? Money.zero(tx.money.currency),
        );
      }
      await transactions.update(tx, at);
      return exhausted ? tx.kind : undefined;
    });
  }

  /** `BASE · 2^attempts` limitado a `CAP`, com ±20% de jitter para não sincronizar instâncias. */
  private nextCheck(at: Date, attempts: number): Date {
    const delay = exponentialBackoffMs(attempts + 1, this.settings.backoff);
    return addMs(at, Math.round(delay * (0.8 + Math.random() * 0.4)));
  }
}
