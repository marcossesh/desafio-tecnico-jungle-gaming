import { Migration } from '@mikro-orm/migrations';

// O claim ordena por `seq` entre os não publicados; sem este índice ele percorre todo o histórico já publicado.
export class Migration0006OutboxPendingSeqIndex extends Migration {
  override up(): void {
    this.addSql('CREATE INDEX outbox_pending_seq_idx ON outbox_messages (seq) WHERE published_at IS NULL');
    this.addSql('DROP INDEX outbox_unpublished_idx');
  }

  override down(): void {
    this.addSql(
      'CREATE INDEX outbox_unpublished_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL',
    );
    this.addSql('DROP INDEX outbox_pending_seq_idx');
  }
}
