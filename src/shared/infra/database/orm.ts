import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../../migrations';
import { InboxMessageSchema } from '../../../messaging/infra/persistence/inbox-message.record';
import { OutboxMessageSchema } from '../../../messaging/infra/persistence/outbox-message.record';
import { WagerTransactionSchema } from '../../../wagering/infra/persistence/wager-transaction.record';
import { LedgerEntrySchema } from '../../../wallet/infra/persistence/ledger-entry.record';
import { WalletSchema } from '../../../wallet/infra/persistence/wallet.record';

export function createOrm(options: { clientUrl: string; poolMax?: number }): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: options.clientUrl,
    entities: [
      WalletSchema,
      LedgerEntrySchema,
      WagerTransactionSchema,
      OutboxMessageSchema,
      InboxMessageSchema,
    ],
    pool: { max: options.poolMax ?? 10 },
    extensions: [Migrator],
    migrations: { migrationsList, snapshot: false, silent: true },
  });
}
