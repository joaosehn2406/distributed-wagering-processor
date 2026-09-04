# P0 guardrails

| Invariant | Primary protection | Secondary evidence |
|---|---|---|
| Exact money | `Money` / `decimal.js`; `NUMERIC(20,2)` | Unit money tests |
| No negative wallet | Wallet row `FOR UPDATE`; database check | Two concurrent BET integration scenario |
| No duplicate effect | Idempotency and provider/external unique constraints | Parallel duplicate integration scenario |
| Wallet/ledger atomicity | One MikroORM SQL transaction | Reconciliation endpoint |
| Ledger immutable | PostgreSQL update/delete/truncate triggers | Schema integration test |
| No lost confirmed event | Transactional outbox | Concurrent publisher integration scenario |
| At-least-once SQS | Inbox row in same financial transaction | Crash/redelivery integration scenario |

The database is the final arbiter; FIFO ordering and in-memory process state are never financial guarantees.
