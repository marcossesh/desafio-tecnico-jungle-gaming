import { Migration } from '@mikro-orm/migrations';

export const APP_ROLE = 'wagering_app';
const ROLE = APP_ROLE;

// Defesa além dos triggers: a aplicação nem tem permissão de alterar o ledger nem a inbox.
export class Migration0007AppRole extends Migration {
  override up(): void {
    // role é do cluster (vale para todos os bancos); o login com senha é provisionado fora da migration
    this.addSql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} NOLOGIN; END IF;
      END $$`);
    this.addSql(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    this.addSql(`GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, outbox_messages TO ${ROLE}`);
    this.addSql(`GRANT SELECT, INSERT ON wallet_ledger_entries, inbox_messages TO ${ROLE}`);
    this.addSql(`GRANT USAGE ON SEQUENCE outbox_messages_seq_seq TO ${ROLE}`);
  }

  // revoga só neste banco: o role pode ter permissões em outros bancos do cluster
  override down(): void {
    this.addSql(`REVOKE USAGE ON SEQUENCE outbox_messages_seq_seq FROM ${ROLE}`);
    this.addSql(
      `REVOKE ALL ON wallets, wager_transactions, outbox_messages, wallet_ledger_entries, inbox_messages FROM ${ROLE}`,
    );
    this.addSql(`REVOKE USAGE ON SCHEMA public FROM ${ROLE}`);
  }
}
