/**
 * Schema-level reinforcement for terminal snapshots, reference context and
 * stable outbox envelopes. These checks complement (and never replace) the
 * domain rules executed while the wallet row is locked.
 */
export const migration0003 = {
  name: '0003_financial_guardrails',
  up: `
ALTER TABLE wager_transactions
  ADD CONSTRAINT wager_terminal_snapshot_ck CHECK (
    (status IN ('PROCESSED','REJECTED','FAILED') AND result_balance IS NOT NULL AND result_balance >= 0 AND result_version IS NOT NULL AND result_version >= 1)
    OR status IN ('PENDING','PENDING_REFERENCE')
  ),
  ADD CONSTRAINT wager_pending_snapshot_ck CHECK (
    status <> 'PENDING_REFERENCE'
    OR (accepted_balance IS NOT NULL AND accepted_balance >= 0 AND accepted_version IS NOT NULL AND accepted_version >= 1)
  ),
  ADD CONSTRAINT wager_failure_required_ck CHECK (
    (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
  );
ALTER TABLE wager_transactions
  ADD CONSTRAINT wager_reference_context_uk UNIQUE (id,provider_id,player_id,wallet_id,currency,round_id,amount);
ALTER TABLE wager_transactions
  ADD CONSTRAINT wager_reference_context_fk FOREIGN KEY (reference_transaction_id,provider_id,player_id,wallet_id,currency,round_id,amount)
  REFERENCES wager_transactions(id,provider_id,player_id,wallet_id,currency,round_id,amount);
CREATE INDEX ledger_wallet_cursor_ix ON wallet_ledger_entries(wallet_id,created_at,id);
ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_envelope_matches_columns_ck CHECK (
    payload ? 'eventId'
    AND payload ? 'eventType'
    AND payload ? 'aggregateId'
    AND payload ? 'correlationId'
    AND payload ? 'occurredAt'
    AND payload ? 'version'
    AND payload ? 'data'
    AND payload->>'eventId' = event_id::text
    AND payload->>'eventType' = event_type
    AND payload->>'aggregateId' = aggregate_id::text
    AND (payload->>'version')::integer = event_version
  );
`,
  down: `
ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS outbox_envelope_matches_columns_ck;
DROP INDEX IF EXISTS ledger_wallet_cursor_ix;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_reference_context_fk;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_reference_context_uk;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_failure_required_ck;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_pending_snapshot_ck;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_terminal_snapshot_ck;
`,
};
