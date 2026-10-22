import { Migration } from '@mikro-orm/migrations';

export class Migration0004InboxOutbox extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);
    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        seq bigserial NOT NULL,
        aggregate_id uuid NOT NULL,
        partition_key text NOT NULL,
        event_type text NOT NULL,
        event_version integer NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL,
        locked_until timestamptz NULL,
        published_at timestamptz NULL,
        last_error text NULL,
        CONSTRAINT outbox_seq_unique UNIQUE (seq),
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    this.addSql(
      'CREATE INDEX outbox_unpublished_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL',
    );
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
  }
}
