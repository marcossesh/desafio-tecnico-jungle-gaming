import type { MikroORM } from '@mikro-orm/postgresql';
import type { FailpointName } from '../../src/shared/application/failpoints';
import { MikroOrmUnitOfWork } from '../../src/shared/infra/database/mikro-orm-unit-of-work';
import { createOrm } from '../../src/shared/infra/database/orm';
import { failpointsFrom } from '../../src/shared/infra/failpoints';
import { systemClock, uuidV7Generator } from '../../src/shared/infra/system';
import { Money } from '../../src/shared/money/money';
import {
  ProcessWagerTransaction,
  type WagerCommand,
} from '../../src/wagering/application/process-wager-transaction';
import { OpenWallet } from '../../src/wallet/application/open-wallet';
import type { Wallet } from '../../src/wallet/domain/wallet';

/** Casos de uso montados direto sobre um banco de teste, sem HTTP. */
export interface UseCases {
  orm: MikroORM;
  openWallet(amount: string): Promise<Wallet>;
  processWager(failpoints?: FailpointName[]): ProcessWagerTransaction;
  close(): Promise<void>;
}

export async function createUseCases(databaseUrl: string): Promise<UseCases> {
  const orm = await createOrm({ clientUrl: databaseUrl, poolMax: 5 });
  const uow = new MikroOrmUnitOfWork(orm);
  return {
    orm,
    openWallet: (amount) =>
      new OpenWallet(uow, uuidV7Generator, systemClock).execute({
        playerId: Bun.randomUUIDv7(),
        initialBalance: Money.from({ amount, currency: 'BRL' }),
        correlationId: 'test',
      }),
    processWager: (failpoints = []) =>
      new ProcessWagerTransaction(uow, uuidV7Generator, systemClock, failpointsFrom(failpoints.join(',')), {
        lockTimeoutMs: 3_000,
        pendingReferenceBaseMs: 2_000,
        maxReferenceAttempts: 10,
        maxAttempts: 3,
      }),
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
