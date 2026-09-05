/** Initial PostgreSQL schema. It is deliberately SQL-first for named, auditable constraints. */
export const migration0001 = {
  name: '0001_initial',
  up: `
CREATE TABLE IF NOT EXISTS schema_migrations (name varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE wallets (
 id uuid PRIMARY KEY, player_id uuid NOT NULL, currency char(3) NOT NULL, balance numeric(20,2) NOT NULL,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CONSTRAINT wallets_player_currency_uk UNIQUE (player_id,currency), CONSTRAINT wallets_identity_uk UNIQUE (id,player_id,currency), CONSTRAINT wallets_id_currency_uk UNIQUE (id,currency),
 CONSTRAINT wallets_balance_nonnegative_ck CHECK (balance >= 0), CONSTRAINT wallets_version_ck CHECK (version >= 1), CONSTRAINT wallets_currency_ck CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE TABLE wager_transactions (
 id uuid PRIMARY KEY, provider_id varchar(100) NOT NULL, external_transaction_id varchar(200) NOT NULL, idempotency_key varchar(255) NOT NULL, payload_hash char(64) NOT NULL,
 wallet_id uuid NOT NULL, player_id uuid NOT NULL, round_id varchar(200) NOT NULL, game_id varchar(200) NOT NULL, kind varchar(10) NOT NULL,
 amount numeric(20,2) NOT NULL, currency char(3) NOT NULL, reference_external_transaction_id varchar(200), reference_transaction_id uuid,
 status varchar(20) NOT NULL, failure_code varchar(100), accepted_balance numeric(20,2), accepted_version bigint, result_balance numeric(20,2), result_version bigint,
 reference_attempts integer NOT NULL DEFAULT 0, next_reference_attempt_at timestamptz, reference_expires_at timestamptz, processed_at timestamptz, terminal_at timestamptz,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CONSTRAINT wager_idempotency_uk UNIQUE (idempotency_key), CONSTRAINT wager_provider_external_uk UNIQUE (provider_id,external_transaction_id), CONSTRAINT wager_id_wallet_currency_uk UNIQUE (id,wallet_id,currency),
 CONSTRAINT wager_wallet_identity_fk FOREIGN KEY (wallet_id,player_id,currency) REFERENCES wallets(id,player_id,currency),
 CONSTRAINT wager_reference_fk FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions(id),
 CONSTRAINT wager_amount_positive_ck CHECK (amount > 0), CONSTRAINT wager_kind_ck CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
 CONSTRAINT wager_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
 CONSTRAINT wager_reference_required_ck CHECK ((kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL) OR kind NOT IN ('REFUND','ROLLBACK')),
 CONSTRAINT wager_no_self_reference_ck CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
 CONSTRAINT wager_failure_status_ck CHECK ((failure_code IS NULL) OR status IN ('REJECTED','FAILED')),
 CONSTRAINT wager_processed_status_ck CHECK ((processed_at IS NULL) = (status <> 'PROCESSED')),
 CONSTRAINT wager_terminal_status_ck CHECK ((terminal_at IS NOT NULL) = (status IN ('PROCESSED','REJECTED','FAILED'))),
 CONSTRAINT wager_pending_retry_ck CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL AND reference_expires_at IS NOT NULL))
);
CREATE INDEX wager_pending_reference_ix ON wager_transactions(status,next_reference_attempt_at) WHERE status='PENDING_REFERENCE';
CREATE UNIQUE INDEX wager_processed_reverse_uk ON wager_transactions(reference_transaction_id,kind) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE TABLE wallet_ledger_entries (
 id uuid PRIMARY KEY, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL, direction varchar(6) NOT NULL,
 amount numeric(20,2) NOT NULL, currency char(3) NOT NULL, balance_before numeric(20,2) NOT NULL, balance_after numeric(20,2) NOT NULL, created_at timestamptz NOT NULL,
 CONSTRAINT ledger_wallet_transaction_uk UNIQUE(wallet_id,transaction_id), CONSTRAINT ledger_direction_ck CHECK(direction IN ('CREDIT','DEBIT')),
 CONSTRAINT ledger_amount_positive_ck CHECK(amount > 0), CONSTRAINT ledger_balances_nonnegative_ck CHECK(balance_before >= 0 AND balance_after >= 0),
 CONSTRAINT ledger_arithmetic_ck CHECK((direction='CREDIT' AND balance_after=balance_before+amount) OR (direction='DEBIT' AND balance_after=balance_before-amount)),
 CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency),
 CONSTRAINT ledger_transaction_wallet_currency_fk FOREIGN KEY(transaction_id,wallet_id,currency) REFERENCES wager_transactions(id,wallet_id,currency)
);
CREATE TABLE inbox_messages (consumer_name varchar(100) NOT NULL, message_id varchar(255) NOT NULL, payload_hash char(64) NOT NULL, transport_message_id varchar(255), received_at timestamptz NOT NULL, processed_at timestamptz, PRIMARY KEY(consumer_name,message_id));
CREATE TABLE outbox_messages (id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE, aggregate_id uuid NOT NULL, event_type varchar(100) NOT NULL, event_version integer NOT NULL DEFAULT 1, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL, published_at timestamptz, last_error_code varchar(100), created_at timestamptz NOT NULL);
CREATE INDEX outbox_due_ix ON outbox_messages(next_attempt_at,created_at) WHERE published_at IS NULL;
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'wallet ledger is append-only'; END; $$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
`,
  down: `DROP TABLE IF EXISTS outbox_messages; DROP TABLE IF EXISTS inbox_messages; DROP TABLE IF EXISTS wallet_ledger_entries; DROP TABLE IF EXISTS wager_transactions; DROP TABLE IF EXISTS wallets; DROP FUNCTION IF EXISTS reject_ledger_mutation();`,
};
