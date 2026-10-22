import { NotFoundError } from '../../shared/application/errors';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { WagerTransaction } from '../domain/wager-transaction';

export class TransactionNotFoundError extends NotFoundError {
  constructor(description: string) {
    super('TRANSACTION_NOT_FOUND', `Transaction ${description} not found`);
  }
}

export class WagerQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<WagerTransaction> {
    const found = await this.uow.run(({ transactions }) => transactions.findById(transactionId), {
      readOnly: true,
    });
    if (!found) throw new TransactionNotFoundError(transactionId);
    return found;
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const found = await this.uow.run(
      ({ transactions }) => transactions.findByExternalId(providerId, externalTransactionId),
      { readOnly: true },
    );
    if (!found) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return found;
  }
}
