# Architecture

This implementation follows `../ARCHITECTURAL_DECISIONS.md`. It is a modular NestJS monolith using MikroORM transaction boundaries and PostgreSQL as the final consistency authority.

`APP_ROLE` selects `api`, `sqs-consumer`, `outbox-publisher`, `pending-worker`, or `all`. Financial commands always take the wallet row with `SELECT ... FOR UPDATE`, then recheck persistent idempotency before any write. Wallet, transaction, ledger, Inbox (when applicable), and Outbox are committed in one SQL transaction.

The pure domain is under `src/shared/domain`, `src/wallet/domain`, and `src/wagering/domain`; it has no Nest, ORM, or AWS dependency. `Money` uses `decimal.js` internally and accepts/serializes only `{ amount: string, currency: string }` with two decimal places. PostgreSQL stores values as `NUMERIC(20,2)`.

The opening balance is committed atomically with its `OPENING` transaction, conditional credit ledger entry, and Outbox events. It leaves wallet version at `1`. Later balance movements increment it once. `LOSS`, replays, rejections, and pending references do not change it.

Authentication is intentionally deferred: `NoopAuthGuard` is the explicit seam for an OIDC `ProviderIdentityPort` adapter. No local-password authentication exists.

Integration events are concrete subclasses of the abstract `IntegrationEvent<T>`.
Their persisted and published envelope has a stable `eventId`, `eventType`,
`aggregateId`, correlation/causation identifiers, ISO timestamp, and type-owned
`version`; monetary fields in `data` are `MoneyProps`, never runtime `Money`.

Outbox publishing is at-least-once. A crash after SQS accepts an event but before
`published_at` is recorded may duplicate that event; downstream consumers must
deduplicate the stable `eventId`. Migration `0002_outbox_leases` adds a lease
token, holder and expiry. Publishers claim due rows using `FOR UPDATE SKIP
LOCKED`, perform the network call outside the transaction, and conditionally
complete/retry the same lease. `APP_INSTANCE_ID`, outbox lease, batch and
backoff values are configuration, not correctness dependencies. `SKIP LOCKED`
makes workers concurrent but is not treated as causal event ordering.

The SQS consumer persists its Inbox claim inside the financial transaction and
deletes the SQS receipt only after that commit. Structural, size, UUID and
monetary envelope violations are copied to the DLQ before acknowledgement;
terminal business errors are acknowledged; transient errors receive a
broker-visible exponential visibility backoff and are routed to the DLQ only
after the configured receive limit. During shutdown it stops polling, waits for
the bounded drain period, then returns visibility for receipts still in flight.

Pending `REFUND`/`ROLLBACK` references remain durable
`PENDING_REFERENCE` transactions. A worker claims due rows with row locks,
uses configurable exponential backoff, TTL and maximum attempt count, and
emits the terminal event if the reference is ultimately absent. Recreating a
worker is sufficient to resume this persisted work; there is no in-memory
pending queue.

## HTTP, observability and operational roles

HTTP input uses class-validator DTOs with whitelist/rejection of unknown fields.
Money is accepted only as a two-decimal string and no controller converts it
through a JavaScript number. The exception filter maps invalid payloads,
not-found, idempotency conflicts, business rejections and transient dependency
failures to distinct stable statuses/codes. Every request receives an
`X-Correlation-Id`; it is passed into financial commands and integration-event
envelopes.

Logs are one-line JSON and have fixed, payload-safe fields only:
`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, status,
code and component. The logger intentionally does not accept monetary fields or
raw request/message payloads. Prometheus metrics cover terminal/pending
transactions, replayed deliveries, retries, DLQ routing, lock races, outbox lag,
processing latency and reconciliation divergence. Liveness is process-only;
readiness performs live PostgreSQL and all required SQS queue checks.
The API exposes those endpoints on `PORT`; worker roles may expose their own
process-local `/metrics` and health endpoint on `METRICS_PORT` for a trusted
Prometheus network, avoiding the loss of consumer/publisher telemetry in a
separate-process deployment.

Docker Compose starts role-specific processes instead of relying on `APP_ROLE=all`:
an API, one command consumer, two independent publishers and one pending-reference
worker. The `process-crash-recovery` integration test uses the same role entry
point in separate child processes, kills a consumer after SQL commit and before
SQS acknowledgement, then proves that a fresh consumer performs only the Inbox
acknowledgement replay while two publishers finish the durable outbox. This
test-only crash hook is guarded by `RUN_CRASH_TEST=true`.
