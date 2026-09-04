# Architecture

This implementation follows `../ARCHITECTURAL_DECISIONS.md`. It is a modular NestJS monolith using MikroORM transaction boundaries and PostgreSQL as the final consistency authority.

`APP_ROLE` selects `api`, `sqs-consumer`, `outbox-publisher`, `pending-worker`, or `all`. Financial commands always take the wallet row with `SELECT ... FOR UPDATE`, then recheck persistent idempotency before any write. Wallet, transaction, ledger, Inbox (when applicable), and Outbox are committed in one SQL transaction.

The pure domain is under `src/shared/domain`, `src/wallet/domain`, and `src/wagering/domain`; it has no Nest, ORM, or AWS dependency. `Money` uses `decimal.js` internally and accepts/serializes only `{ amount: string, currency: string }` with two decimal places. PostgreSQL stores values as `NUMERIC(20,2)`.

The opening balance is committed atomically with its `OPENING` transaction, conditional credit ledger entry, and Outbox events. It leaves wallet version at `1`. Later balance movements increment it once. `LOSS`, replays, rejections, and pending references do not change it.

Authentication is intentionally deferred: `NoopAuthGuard` is the explicit seam for an OIDC `ProviderIdentityPort` adapter. No local-password authentication exists.

Outbox publishing is at-least-once. A crash after SQS accepts an event but before `published_at` is recorded may duplicate that event; downstream consumers must deduplicate stable `eventId`. `SKIP LOCKED` makes workers concurrent but is not treated as causal event ordering.
