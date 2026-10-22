import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../shared/application/errors';
import type { WalletRepository } from '../../application/ports';
import type { Wallet } from '../../domain/wallet';
import { WalletSchema, walletToDomain, walletToRecord } from './wallet.record';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletToRecord(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { disableIdentityMap: true });
    return record ? walletToDomain(record) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? walletToDomain(record) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const { balance, version, updatedAt } = walletToRecord(wallet);
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance, version, updatedAt },
    );
    if (affected !== 1) throw new ConcurrencyConflictError(wallet.id);
  }
}
