import { Migration } from '@mikro-orm/migrations';

export class Migration0003WalletLedgerEntries extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        wallet_version integer NOT NULL,
        direction text NOT NULL,
        amount numeric(20,2) NOT NULL,
        currency char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after numeric(20,2) NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT ledger_transaction_wallet_fk
          FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_wallet_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wallet_ledger_entries');
  }
}
