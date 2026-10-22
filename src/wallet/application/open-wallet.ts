import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { ConflictError, UniqueConstraintError } from '../../shared/application/errors';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { Clock, IdGenerator } from '../../shared/domain/ports';
import type { Money } from '../../shared/money/money';
import { WalletBalanceChanged } from '../../wagering/domain/events';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Wallet, OPENING, lançamento e evento na mesma transação SQL. */
  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const at = this.clock.now();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      at,
    });

    try {
      await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
        await wallets.insert(wallet);
        if (!openingEntry) return;
        await transactions.insert(
          WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: command.initialBalance,
            correlationId: command.correlationId,
            at,
          }),
        );
        await ledger.insert(openingEntry);
        const event = WalletBalanceChanged.from(wallet, openingEntry, {
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          occurredAt: at,
        });
        await outbox.add([OutboxMessage.enqueue(event)]);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError && error.constraint === 'wallets_player_currency_unique') {
        throw new ConflictError(
          'WALLET_ALREADY_EXISTS',
          `Player ${command.playerId} already has a ${wallet.currency} wallet`,
        );
      }
      throw error;
    }
    return wallet;
  }
}
