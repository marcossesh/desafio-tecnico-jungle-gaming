import { Migration } from '@mikro-orm/migrations';

// Violações de invariante usam SQLSTATE 23000: não são erro de negócio, indicam bug no chamador.
export class Migration0005IntegrityTriggers extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION wallets_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % must start at version 1', NEW.id USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallet % cannot be deleted', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet % identity columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.version NOT IN (OLD.version, OLD.version + 1)
           OR (NEW.balance <> OLD.balance) <> (NEW.version = OLD.version + 1) THEN
          RAISE EXCEPTION 'wallet % version must advance by exactly one iff balance changes (% -> %)',
            OLD.id, OLD.version, NEW.version USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$
    `);
    this.addSql(`
      CREATE TRIGGER wallets_version_guard BEFORE INSERT OR UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_version_guard()
    `);

    // Deferred: saldo e lançamento são gravados em statements distintos da mesma transação.
    this.addSql(`
      CREATE FUNCTION wallets_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM wallet_ledger_entries
           WHERE wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance
        ) OR (
          NEW.balance = 0 AND NEW.version = 1
          AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.id)
        ) THEN
          RETURN NULL;
        END IF;
        RAISE EXCEPTION 'wallet % balance % at version % has no matching ledger entry', NEW.id, NEW.balance, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_balance_matches_ledger()
    `);

    this.addSql(`
      CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% rejected)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable()
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable()
    `);

    this.addSql(`
      CREATE FUNCTION ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous_after numeric(20,2);
      BEGIN
        SELECT balance_after INTO previous_after FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
        IF NEW.balance_before <> COALESCE(previous_after, 0) THEN
          RAISE EXCEPTION 'ledger chain broken for wallet % at version %: balance_before % <> previous balance_after %',
            NEW.wallet_id, NEW.wallet_version, NEW.balance_before, COALESCE(previous_after, 0)
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_chain()
    `);

    // Recíproca do anterior: lançamento só existe se a wallet avançou até ele e a transação moveu saldo.
    this.addSql(`
      CREATE FUNCTION ledger_entry_applied() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM wallets WHERE id = NEW.wallet_id AND version >= NEW.wallet_version) THEN
          RAISE EXCEPTION 'ledger entry % at version % has no matching wallet balance change', NEW.id, NEW.wallet_version
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wager_transactions WHERE id = NEW.transaction_id AND status = 'PROCESSED' AND kind <> 'LOSS'
        ) THEN
          RAISE EXCEPTION 'ledger entry % belongs to a transaction that does not move balance', NEW.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_entry_applied AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_applied()
    `);

    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transaction % cannot be deleted', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id,
            NEW.player_id, NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id,
            OLD.player_id, OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager transaction % business columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER wager_transactions_guard ON wager_transactions');
    this.addSql('DROP FUNCTION wager_transactions_guard()');
    this.addSql('DROP TRIGGER ledger_entry_applied ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION ledger_entry_applied()');
    this.addSql('DROP TRIGGER ledger_chain ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION ledger_chain()');
    this.addSql('DROP TRIGGER ledger_immutable_truncate ON wallet_ledger_entries');
    this.addSql('DROP TRIGGER ledger_immutable ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION ledger_immutable()');
    this.addSql('DROP TRIGGER wallets_balance_matches_ledger ON wallets');
    this.addSql('DROP FUNCTION wallets_balance_matches_ledger()');
    this.addSql('DROP TRIGGER wallets_version_guard ON wallets');
    this.addSql('DROP FUNCTION wallets_version_guard()');
  }
}
