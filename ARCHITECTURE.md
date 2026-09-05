# Architecture

This is a self-contained architecture document for the code in this repository. It is a modular NestJS monolith using MikroORM transaction boundaries and PostgreSQL as the final consistency authority. PostgreSQL, rather than SQS or memory, stores the materialized balance, immutable ledger, wager state, Inbox and Outbox; it is the only component that decides whether a financial effect committed. SQS is transport only: FIFO ordering reduces avoidable contention but never replaces locks or persistent idempotency.

`APP_ROLE` selects `api`, `sqs-consumer`, `outbox-publisher`, `pending-worker`, or `all`. Financial commands always take the wallet row with `SELECT ... FOR UPDATE`, then recheck persistent idempotency before any write. The lock is deliberately limited to one wallet: same-wallet commands serialize, while different wallets have no global application lock, advisory lock or shared in-memory mutex. Wallet, transaction, ledger, Inbox (when applicable), and Outbox are committed in one SQL transaction.

The pure domain is under `src/shared/domain`, `src/wallet/domain`, and `src/wagering/domain`; it has no Nest, ORM, or AWS dependency. `Money` uses `decimal.js` internally and accepts/serializes only `{ amount: string, currency: string }` with two decimal places. PostgreSQL stores values as `NUMERIC(20,2)`. JavaScript `number` is used only for ports, durations, dates, metrics and event versions, never to represent or calculate money.

`WalletLedgerEntry` is an immutable domain entity. Its factory checks currency,
positive amount, non-negative before/after balances and debit/credit arithmetic
before the repository performs an insert. PostgreSQL repeats those protections
with checks, foreign keys and append-only triggers; neither layer is optional.

The opening balance is committed atomically with its `OPENING` transaction, conditional credit ledger entry, and Outbox events. It leaves wallet version at `1`. Later balance movements increment it once. `LOSS`, replays, rejections, and pending references do not change it.

Authentication is intentionally deferred: `NoopAuthGuard` is the explicit replacement seam for an external OIDC `ProviderIdentityPort` adapter. No local-password authentication exists; health endpoints and the internal queue remain outside that future authentication boundary.

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

Migrations are ordered and reversible (`0001_initial`, `0002_outbox_leases`,
`0003_financial_guardrails`). The final migration adds terminal/pending snapshot
checks, a same-context reference FK, a stable ledger cursor index, and a check
that persisted outbox columns agree with their versioned JSON envelope.

The SQS consumer persists its Inbox claim inside the financial transaction and
deletes the SQS receipt only after that commit. Structural, size, UUID and
monetary envelope violations are copied to the DLQ before acknowledgement;
terminal business errors are acknowledged; transient errors receive a
broker-visible exponential visibility backoff and are routed to the DLQ only
after the configured receive limit. During shutdown it stops polling, waits for
the bounded drain period, then returns visibility for receipts still in flight.
DLQ copies retain the original message body and carry `failureReason` plus the
full logical message ID as SQS attributes. An Inbox claim still in progress is
deferred without consuming the DLQ retry budget: it represents another active
delivery, not a permanently failing command.

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
worker. When run against PostgreSQL and LocalStack, the
`process-crash-recovery` integration test uses the same role entry point in
separate child processes, kills a consumer after SQL commit and before SQS
acknowledgement, then checks that a fresh consumer performs only the Inbox
acknowledgement replay while two publishers finish the durable outbox. This
test-only crash hook is guarded by `RUN_CRASH_TEST=true`.

## Exact SQL boundary and business semantics

The authoritative write path is: claim Inbox when the source is SQS; lock the
wallet; recheck idempotency/provider-external identity; insert the wager in
`PENDING`; resolve the rule; update the wallet and insert its ledger child when
there is a movement; update the wager snapshot; insert Outbox events; complete
Inbox; then commit. The wager parent is thus durable before its non-deferrable
ledger child, and no network call occurs under the wallet lock or transaction.
An HTTP response and an SQS `DeleteMessage` both happen only after commit.

The canonical SHA-256 hash contains sorted business fields only (provider,
external transaction, wallet/player/round/game, kind, exact Money and optional
reference). Transport IDs, timestamps and correlation metadata are excluded.
Same key plus same hash returns the stored original snapshot; same key with a
different hash is a conflict. `BET` debits, `WIN` credits (and may optionally
reference a BET), `LOSS` records no movement, `REFUND` reverses one compatible
BET, and `ROLLBACK` inverts a compatible BET/WIN/REFUND. A reversal that would
make the wallet negative is explicitly rejected.

The trade-off is intentional: pessimistic per-wallet serialization favors a
financially unambiguous balance over maximal write throughput. Outbox delivery
is at-least-once rather than an impossible cross-system exactly-once commit;
downstream event consumers must deduplicate `eventId`. `SKIP LOCKED` improves
worker concurrency but is not treated as causal ordering.

## Validation boundary

Static checks, unit tests and the full integration suite passed. The integration
proof ran against PostgreSQL and LocalStack real services inside the Compose
network: seven tests and 91 assertions covered database constraints, 50-way
concurrency, three independent Nest/Bun processes, SQS DLQ/retry/redelivery,
two publishers, pending-reference recovery, crash after commit/before ACK and
exact reconciliation. `/health/live`, `/health/ready` and `/metrics` also
responded against the running stack.

This host has a separate PostgreSQL process on host port `5432`, so the proof
used `docker compose run --rm --no-deps api bun run test:integration` rather
than accidentally testing that external database. `POSTGRES_HOST_PORT` and
`LOCALSTACK_HOST_PORT` make host mappings configurable when direct host test
execution is preferred. The evidence and exact results are recorded in
`IMPLEMENTATION_STATUS.md` and `VALIDACAO_FINAL.md`.
