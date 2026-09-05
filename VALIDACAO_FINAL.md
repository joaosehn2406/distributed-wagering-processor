# Validação final de submissão

Data: 05/09/2026  
Escopo: somente `distributed-wagering-processor`.

## Critério de status

- **IMPLEMENTADO E VALIDADO** — há implementação e evidência executada nesta
  revisão.
- **IMPLEMENTADO MAS NÃO EXECUTADO** — há código e teste/inspeção identificados,
  mas a prova que exige PostgreSQL, LocalStack ou Docker não rodou neste host.
- **PENDENTE** — falta implementação ou evidência definida.

As verificações estáticas e unitárias não são usadas para promover uma garantia
distribuída a “validada”. Não foi encontrado P0/P1 estático nesta revisão, mas
os cenários distribuídos continuam bloqueadores de submissão até execução real.

## Matriz de requisitos

| Requisito do enunciado                                                      | Arquivo(s) que implementam                                                                                              | Teste(s) que comprovam                                                               | Status                         | Observação                                                                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Bun, TypeScript estrito, NestJS, MikroORM, PostgreSQL, SQS e Compose        | `package.json`, `tsconfig.json`, `src/app.module.ts`, `Dockerfile`, `docker-compose.yml`                                | `bun run build`; `docker compose config --quiet`                                     | IMPLEMENTADO E VALIDADO        | Configuração Compose foi validada semanticamente; o daemon não estava acessível para iniciar containers.                          |
| Dinheiro exato, imutável, duas casas e sem JSON numérico                    | `src/shared/domain/money.ts`, `src/bootstrap/http.dto.ts`                                                               | `test/unit/money.test.ts`, `test/unit/http-contract.test.ts`                         | IMPLEMENTADO E VALIDADO        | `decimal.js` interno e `NUMERIC(20,2)` na migration; `number` remanescente é infra/tempo/métrica.                                 |
| Wallet não negativa, moeda coerente e versão                                | `src/wallet/domain/wallet.ts`, `Migration0001Initial.ts`                                                                | `test/unit/wallet.test.ts`                                                           | IMPLEMENTADO E VALIDADO        | A prova entre processos depende das corridas de integração abaixo.                                                                |
| Abertura zero sem `OPENING`, ledger ou evento; abertura positiva atômica    | `src/wallet/application/create-wallet.use-case.ts`, `Migration0001Initial.ts`                                           | `test/integration/financial-core.test.ts`                                            | IMPLEMENTADO MAS NÃO EXECUTADO | O teste consulta wagers, ledger e outbox reais.                                                                                   |
| Wager pai persistida antes do ledger filho                                  | `src/wagering/application/submit-wager-transaction.use-case.ts`, `wager.repository.ts`                                  | `test/integration/financial-core.test.ts`                                            | IMPLEMENTADO MAS NÃO EXECUTADO | `INSERT wager_transactions(PENDING)` antecede `INSERT wallet_ledger_entries`; a FK não é deferrable.                              |
| Atomicidade wallet+wager+ledger+Inbox+Outbox                                | `submit-wager-transaction.use-case.ts`, `database.service.ts`                                                           | `financial-core.test.ts` (trigger de falha), `distributed-delivery.test.ts`          | IMPLEMENTADO MAS NÃO EXECUTADO | Testes usam trigger PostgreSQL para provar rollback de todos os efeitos.                                                          |
| Lock por wallet, sem lock global e sem lost update                          | `WagerRepository.lockWallet`, `submit-wager-transaction.use-case.ts`                                                    | `test/integration/concurrency.test.ts`, `three-process-wallet-race.test.ts`          | IMPLEMENTADO MAS NÃO EXECUTADO | Só há `SELECT ... FOR UPDATE` da wallet; três conexões/processos compartilham o banco no teste.                                   |
| Constraints, índices, FKs, imutabilidade do ledger e migrations reversíveis | `Migration0001Initial.ts`, `Migration0002OutboxLeases.ts`, `Migration0003FinancialGuardrails.ts`, `migration-runner.ts` | `migrations.test.ts`, `schema-guardrails.test.ts`, `financial-core.test.ts`          | IMPLEMENTADO MAS NÃO EXECUTADO | `up/down/up`, trigger append-only e constraints são exercidos diretamente em PostgreSQL.                                          |
| Idempotência persistente, hash canônico, replay e conflito divergente       | `canonical-hash.ts`, `submit-wager-transaction.use-case.ts`, constraints únicas                                         | `canonical-hash.test.ts`, `concurrency.test.ts`, `three-process-wallet-race.test.ts` | IMPLEMENTADO MAS NÃO EXECUTADO | O hash exclui metadados de transporte; a corrida real de 50 requisições aguarda banco.                                            |
| BET, WIN, LOSS, REFUND e ROLLBACK com regras de referência                  | `wager-transaction.ts`, `submit-wager-transaction.use-case.ts`                                                          | `financial-core.test.ts`, `distributed-delivery.test.ts`                             | IMPLEMENTADO MAS NÃO EXECUTADO | WIN pode referenciar BET opcionalmente; REFUND/ROLLBACK exigem referência e preservam snapshots terminais.                        |
| Reversão única e rollback que evitaria saldo negativo rejeitado             | `wager.repository.ts`, `Migration0001Initial.ts`, `submit-wager-transaction.use-case.ts`                                | `financial-core.test.ts`                                                             | IMPLEMENTADO MAS NÃO EXECUTADO | Índice parcial e verificação sob lock são defesas complementares.                                                                 |
| Pending reference com TTL, tentativas e backoff configuráveis               | `environment.ts`, `backoff.ts`, `pending-reference.worker.ts`                                                           | `backoff.test.ts`, `distributed-delivery.test.ts`                                    | IMPLEMENTADO MAS NÃO EXECUTADO | A expiração e a retomada usam PostgreSQL/LocalStack reais no teste.                                                               |
| Envelope de evento tipado/versionado com correlação e causação              | `integration-event.ts`, `wager-events.ts`, `Migration0003FinancialGuardrails.ts`                                        | `integration-events.test.ts`                                                         | IMPLEMENTADO E VALIDADO        | `causationId` é opcional por contrato; comandos SQS usam o ID lógico como causação.                                               |
| Outbox transacional, lease concorrente, retry e recuperação                 | `outbox-publisher.worker.ts`, `wager.repository.ts`, `Migration0002OutboxLeases.ts`                                     | `distributed-delivery.test.ts`, `process-crash-recovery.test.ts`                     | IMPLEMENTADO MAS NÃO EXECUTADO | A chamada SQS ocorre fora da transação curta de claim; publicação é at-least-once.                                                |
| Consumer SQS valida envelope, Inbox, ACK pós-commit, retry, DLQ e shutdown  | `sqs-consumer.ts`, `sqs.service.ts`, `inbox-message.ts`                                                                 | `distributed-delivery.test.ts`, `process-crash-recovery.test.ts`                     | IMPLEMENTADO MAS NÃO EXECUTADO | DLQ preserva body e inclui `failureReason`/`logicalMessageId`; não há ACK antes do retorno transacional.                          |
| Mesma BET 50 vezes em paralelo: um débito e um ledger                       | `submit-wager-transaction.use-case.ts`, `wager.repository.ts`                                                           | `concurrency.test.ts`, `three-process-wallet-race.test.ts`                           | IMPLEMENTADO MAS NÃO EXECUTADO | Asserções contam `wager_transactions` e lançamentos `DEBIT`, depois reconciliam.                                                  |
| Duas BET de 80.00 contra saldo 100.00: uma processada e uma rejeitada       | `wallet.ts`, `submit-wager-transaction.use-case.ts`                                                                     | `concurrency.test.ts`, `three-process-wallet-race.test.ts`                           | IMPLEMENTADO MAS NÃO EXECUTADO | Asserções exigem saldo/reconciliação `20.00`, um débito e `INSUFFICIENT_FUNDS`.                                                   |
| Wallets distintas progridem em paralelo                                     | `WagerRepository.lockWallet`                                                                                            | `concurrency.test.ts`, `three-process-wallet-race.test.ts`                           | IMPLEMENTADO MAS NÃO EXECUTADO | Operações concorrentes sobre wallets diferentes exigem ambas `PROCESSED`.                                                         |
| Três processos Bun/Nest independentes compartilham PostgreSQL e SQS         | `main.ts`, `app.module.ts`, roles/workers                                                                               | `three-process-wallet-race.test.ts`                                                  | IMPLEMENTADO MAS NÃO EXECUTADO | O teste inicia três processos `APP_ROLE=all` em portas distintas e exercita HTTP e SQS reais.                                     |
| Dois publishers concorrentes não perdem o mesmo evento                      | `outbox-publisher.worker.ts`, `claimDueOutbox`                                                                          | `distributed-delivery.test.ts`, `process-crash-recovery.test.ts`                     | IMPLEMENTADO MAS NÃO EXECUTADO | Há prova em duas instâncias no processo e em dois processos reais no teste de crash.                                              |
| Redelivery SQS não duplica efeito financeiro                                | `sqs-consumer.ts`, `claimInbox`                                                                                         | `distributed-delivery.test.ts`, `process-crash-recovery.test.ts`                     | IMPLEMENTADO MAS NÃO EXECUTADO | Inbox usa ID lógico e hash persistidos, não cache em memória.                                                                     |
| Mensagem inválida chega à DLQ com motivo rastreável                         | `sqs-consumer.ts`, `sqs.service.ts`                                                                                     | `distributed-delivery.test.ts`                                                       | IMPLEMENTADO MAS NÃO EXECUTADO | A prova lê body e atributos SQS da DLQ.                                                                                           |
| Falha transitória não recebe ACK prematuro                                  | `sqs-consumer.ts`, `backoff.ts`                                                                                         | `distributed-delivery.test.ts`                                                       | IMPLEMENTADO MAS NÃO EXECUTADO | Trigger temporário causa rollback; teste espera redelivery antes de processar.                                                    |
| Crash pós-commit/pré-ACK é reiniciado sem segundo efeito                    | `sqs-consumer.ts`, `main.ts`                                                                                            | `process-crash-recovery.test.ts`                                                     | IMPLEMENTADO MAS NÃO EXECUTADO | Failpoint é guardado por `RUN_CRASH_TEST=true`, mata processo real com código `86` e reinicia consumer/publishers.                |
| Reinício retoma pending references e eventos pendentes                      | `pending-reference.worker.ts`, `outbox-publisher.worker.ts`                                                             | `distributed-delivery.test.ts`, `process-crash-recovery.test.ts`                     | IMPLEMENTADO MAS NÃO EXECUTADO | A pendência é reclamada do banco por worker novo; a outbox é reclamada por leases expiradas/due.                                  |
| Reconciliação exata em todo cenário financeiro                              | `reconcile-wallet.use-case.ts`, `test/support/postgres.ts`                                                              | todos os arquivos em `test/integration/*.test.ts` financeiros                        | IMPLEMENTADO MAS NÃO EXECUTADO | A soma é PostgreSQL `NUMERIC`, sem aproximação ou `toBeCloseTo`.                                                                  |
| DTOs, erros HTTP estáveis e cursor de ledger                                | `http.dto.ts`, `http.controller.ts`, `http-error.ts`, `http-exception.filter.ts`                                        | `http-contract.test.ts`, `process-crash-recovery.test.ts`                            | IMPLEMENTADO E VALIDADO        | O contrato unitário passou; o fluxo HTTP real depende da integração não executada.                                                |
| Logs JSON, métricas de negócio e health checks                              | `structured-logger.ts`, `metrics.service.ts`, `health.service.ts`                                                       | `observability.test.ts`, `process-crash-recovery.test.ts`                            | IMPLEMENTADO E VALIDADO        | Readiness real de PostgreSQL/SQS permanece pendente de infraestrutura.                                                            |
| Papéis escaláveis, Docker e setup reproduzível                              | `docker-compose.yml`, `Dockerfile`, `.env.example`, `scripts/localstack/init-queues.sh`, `README.md`                    | `docker compose config --quiet`                                                      | IMPLEMENTADO E VALIDADO        | Daemon Docker ausente impede `up --build` nesta máquina.                                                                          |
| Autenticação fora de escopo com extensão explícita                          | `noop-auth.guard.ts`, `app.module.ts`, `ARCHITECTURE.md`                                                                | revisão estática                                                                     | IMPLEMENTADO MAS NÃO EXECUTADO | Não há autenticação local; trocar por guard/porta OIDC é o ponto de extensão declarado.                                           |
| Documentação consistente e sem caminhos legados                             | `README.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_STATUS.md`, este arquivo                                                | varredura de links/caminhos e `bun run format:check`                                 | IMPLEMENTADO E VALIDADO        | A arquitetura não referencia mais ADR fora do repositório; o enunciado histórico no README é conteúdo, não instrução operacional. |

## Verificações executadas

| Comando                                           | Resultado nesta revisão                                  | Evidência/limite                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run build`                                   | Aprovado                                                 | Compilação TypeScript concluída.                                                                                                                                           |
| `bun run lint`                                    | Aprovado                                                 | ESLint sem erros.                                                                                                                                                          |
| `bun run format:check`                            | Aprovado                                                 | Prettier sem divergências.                                                                                                                                                 |
| `bun run test:unit`                               | Aprovado                                                 | 19 testes, 59 expectations, 0 falhas.                                                                                                                                      |
| `docker compose config --quiet`                   | Aprovado                                                 | Compose parseado/validado sem iniciar serviços.                                                                                                                            |
| `bun run test:integration`                        | Não aprovado por infraestrutura, sem asserção de domínio | LocalStack recusou `localhost:4566`; PostgreSQL em `localhost:5432` recusou credenciais `wager/wager`. Resultado: 0/7 cenários chegaram ao setup dos recursos temporários. |
| `docker version` / `docker compose up -d --build` | Não executável neste host                                | Docker Engine não está acessível no pipe `//./pipe/docker_engine`.                                                                                                         |

## Varredura final

- `rg` não encontrou `parseFloat`, `toBeCloseTo`, `float` ou `double` em
  `src`/`test`. Ocorrências de `Number` estão restritas a portas, SQS,
  temporização, métricas, cursor de data ou versão de evento.
- Não há `TODO`/`FIXME` de requisito obrigatório no código ou nos testes.
- As queries financeiras usam parâmetros; a composição de SQL para cursor usa
  apenas fragmentos constantes escolhidos pelo código, não entrada do usuário.
- Outbox não chama SQS dentro da transação financeira; consumer só chama
  `DeleteMessage` após o retorno do caso de uso transacional.
- Não há mock substituindo PostgreSQL ou SQS nos testes de integração; eles
  usam `pg`, MikroORM e AWS SDK contra recursos descartáveis reais.

## Bloqueadores objetivos de submissão

**NÃO PRONTO PARA SUBMISSÃO.** Não há defeito P0/P1 estático conhecido, mas
requisitos obrigatórios de concorrência, múltiplos processos, SQS, DLQ, crash,
outbox e reconciliação ainda não possuem evidência dinâmica no ambiente real.

Antes da entrega, em uma máquina com Docker Engine funcional ou endpoints
compatíveis, executar exatamente:

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
bun run test:integration
```

Para infraestrutura externa, definir `INTEGRATION_DATABASE_URL`, `SQS_ENDPOINT`
e as URLs das três filas, depois executar `bun run test:integration`. Só após
todos esses comandos passarem as linhas distribuídas podem mudar para
**IMPLEMENTADO E VALIDADO** e o projeto pode ser declarado pronto.
