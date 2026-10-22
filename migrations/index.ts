import { Migration0001Wallets } from './0001_wallets';
import { Migration0002WagerTransactions } from './0002_wager_transactions';
import { Migration0003WalletLedgerEntries } from './0003_wallet_ledger_entries';
import { Migration0004InboxOutbox } from './0004_inbox_outbox';
import { Migration0005IntegrityTriggers } from './0005_integrity_triggers';
import { Migration0006OutboxPendingSeqIndex } from './0006_outbox_pending_seq_index';

// Lista explícita: o Bun não precisa de glob/descoberta em disco e a ordem fica fixa.
export const migrationsList = [
  { name: '0001_wallets', class: Migration0001Wallets },
  { name: '0002_wager_transactions', class: Migration0002WagerTransactions },
  { name: '0003_wallet_ledger_entries', class: Migration0003WalletLedgerEntries },
  { name: '0004_inbox_outbox', class: Migration0004InboxOutbox },
  { name: '0005_integrity_triggers', class: Migration0005IntegrityTriggers },
  { name: '0006_outbox_pending_seq_index', class: Migration0006OutboxPendingSeqIndex },
];
