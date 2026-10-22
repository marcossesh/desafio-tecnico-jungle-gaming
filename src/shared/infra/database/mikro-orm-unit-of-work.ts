import { type EntityManager, IsolationLevel, type MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmInboxRepository } from '../../../messaging/infra/persistence/inbox.repository';
import { MikroOrmOutboxRepository } from '../../../messaging/infra/persistence/outbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../../wagering/infra/persistence/wager-transaction.repository';
import { MikroOrmLedgerRepository } from '../../../wallet/infra/persistence/ledger.repository';
import { MikroOrmWalletRepository } from '../../../wallet/infra/persistence/wallet.repository';
import type { TransactionOptions, TransactionScope, UnitOfWork } from '../../application/unit-of-work';
import { translateDatabaseError } from './pg-errors';

function scopeFor(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          if (options.lockTimeoutMs !== undefined) {
            await em.execute(`SET LOCAL lock_timeout = '${Math.trunc(options.lockTimeoutMs)}ms'`);
          }
          return work(scopeFor(em));
        },
        {
          isolationLevel:
            options.isolation === 'repeatable read'
              ? IsolationLevel.REPEATABLE_READ
              : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
