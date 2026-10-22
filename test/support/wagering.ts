import type { MikroORM } from '@mikro-orm/postgresql';
import type { FailpointName } from '../../src/shared/application/failpoints';
import type { Clock } from '../../src/shared/domain/ports';
import { MikroOrmUnitOfWork } from '../../src/shared/infra/database/mikro-orm-unit-of-work';
import { createOrm } from '../../src/shared/infra/database/orm';
import { failpointsFrom } from '../../src/shared/infra/failpoints';
import { createLogger } from '../../src/shared/infra/logger';
import { PromMetrics } from '../../src/shared/infra/metrics';
import { systemClock, uuidV7Generator } from '../../src/shared/infra/system';
import { Money } from '../../src/shared/money/money';
import {
  type ProcessWagerSettings,
  ProcessWagerTransaction,
  type WagerCommand,
} from '../../src/wagering/application/process-wager-transaction';
import { ReprocessPendingReferences } from '../../src/wagering/application/reprocess-pending-references';
import { OpenWallet } from '../../src/wallet/application/open-wallet';
import type { Wallet } from '../../src/wallet/domain/wallet';

export const REFERENCE_BACKOFF = { baseMs: 2_000, capMs: 300_000 };

/** Casos de uso montados direto sobre um banco de teste, sem HTTP. */
export interface UseCases {
  orm: MikroORM;
  metrics: PromMetrics;
  openWallet(amount: string): Promise<Wallet>;
  processWager(
    failpoints?: FailpointName[],
    settings?: Partial<ProcessWagerSettings>,
  ): ProcessWagerTransaction;
  reprocess(
    clock: Clock,
    options?: { maxReferenceAttempts?: number; failpoints?: FailpointName[] },
  ): ReprocessPendingReferences;
  close(): Promise<void>;
}

export async function createUseCases(databaseUrl: string): Promise<UseCases> {
  const orm = await createOrm({ clientUrl: databaseUrl, poolMax: 5 });
  const uow = new MikroOrmUnitOfWork(orm);
  const metrics = new PromMetrics();
  return {
    metrics,
    orm,
    openWallet: (amount) =>
      new OpenWallet(uow, uuidV7Generator, systemClock).execute({
        playerId: Bun.randomUUIDv7(),
        initialBalance: Money.from({ amount, currency: 'BRL' }),
        correlationId: 'test',
      }),
    processWager: (failpoints = [], settings = {}) =>
      new ProcessWagerTransaction(
        uow,
        uuidV7Generator,
        systemClock,
        failpointsFrom(failpoints.join(',')),
        metrics,
        {
          lockTimeoutMs: 3_000,
          pendingReferenceBaseMs: REFERENCE_BACKOFF.baseMs,
          maxReferenceAttempts: 10,
          maxAttempts: 3,
          ...settings,
        },
      ),
    reprocess: (clock, options = {}) =>
      new ReprocessPendingReferences(
        uow,
        uuidV7Generator,
        clock,
        failpointsFrom((options.failpoints ?? []).join(',')),
        metrics,
        createLogger('silent'),
        {
          batchSize: 20,
          claimLeaseMs: 30_000,
          backoff: REFERENCE_BACKOFF,
          maxReferenceAttempts: options.maxReferenceAttempts ?? 10,
          lockTimeoutMs: 3_000,
        },
      ),
    close: () => orm.close(),
  };
}

export function betCommand(wallet: Wallet, overrides: Partial<WagerCommand> = {}): WagerCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    ...overrides,
  };
}
