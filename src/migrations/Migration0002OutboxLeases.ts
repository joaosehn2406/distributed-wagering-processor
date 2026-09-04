/** Leases keep publisher network calls outside PostgreSQL transactions. */
export const migration0002 = {
  name: '0002_outbox_leases',
  up: `
ALTER TABLE outbox_messages ADD COLUMN lease_token uuid;
ALTER TABLE outbox_messages ADD COLUMN lease_until timestamptz;
ALTER TABLE outbox_messages ADD COLUMN leased_by varchar(100);
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_lease_pair_ck CHECK ((lease_token IS NULL) = (lease_until IS NULL));
CREATE INDEX outbox_claim_due_ix ON outbox_messages(next_attempt_at,lease_until,created_at) WHERE published_at IS NULL;
`,
  down: `
DROP INDEX IF EXISTS outbox_claim_due_ix;
ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS outbox_lease_pair_ck;
ALTER TABLE outbox_messages DROP COLUMN IF EXISTS leased_by;
ALTER TABLE outbox_messages DROP COLUMN IF EXISTS lease_until;
ALTER TABLE outbox_messages DROP COLUMN IF EXISTS lease_token;
`,
};
