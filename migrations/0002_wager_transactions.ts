import { Migration } from '@mikro-orm/migrations';

export class Migration0002WagerTransactions extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        player_id uuid NOT NULL,
        round_id text NULL,
        game_id text NULL,
        kind text NOT NULL,
        amount numeric(20,2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id text NULL,
        reference_transaction_id uuid NULL REFERENCES wager_transactions (id),
        status text NOT NULL,
        failure_code text NULL,
        result_balance numeric(20,2) NULL,
        result_currency char(3) NULL,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_check_at timestamptz NULL,
        correlation_id text NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        CONSTRAINT wager_tx_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_external_id_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_id_wallet_unique UNIQUE (id, wallet_id),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_tx_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_tx_result_balance_non_negative CHECK (result_balance >= 0),
        CONSTRAINT wager_tx_result_pair CHECK ((result_balance IS NULL) = (result_currency IS NULL)),
        CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_amount_positive CHECK ((kind = 'LOSS' AND amount >= 0) OR amount > 0),
        CONSTRAINT wager_tx_reversal_has_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_tx_round_required CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT wager_tx_processed_shape
          CHECK (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND failure_code IS NULL)),
        CONSTRAINT wager_tx_failure_code_required
          CHECK (status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_pending_reference_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL),
        CONSTRAINT wager_tx_processed_reversal_linked
          CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL)
      )
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_unique ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);
    this.addSql(
      `CREATE UNIQUE INDEX wager_tx_single_opening_unique ON wager_transactions (wallet_id) WHERE kind = 'OPENING'`,
    );
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_lookup_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wager_transactions');
  }
}
