# Implementation status — Entregas A, B e C

Data: 04/09/2026

**Estado: implementação de código concluída; Definition of Done ainda não pode
ser declarada pronta.** Os itens P0 de execução real permanecem pendentes porque
este ambiente não tem Bun nem dependências instaladas e o daemon Docker não está
disponível. Não foram instalados Bun, Docker, imagens ou pacotes nesta tarefa.

Legenda: **implementado** significa que o código e o teste foram revisados;
**validado** exige a execução indicada na última seção.

## Entrega A — núcleo financeiro e migrations

| Requisito | Implementado | Validado |
| --- | --- | --- |
| Wallet `0.00` não cria `OPENING`, ledger ou outbox | Sim — caminho explícito em `CreateWalletUseCase` | Não — integração pendente |
| Abertura positiva persiste wager antes do ledger | Sim — `OPENING` é inserida antes da FK do ledger | Não — integração pendente |
| Wallet, wager, ledger, Inbox e Outbox atômicos | Sim — um único `EntityManager.transactional` | Não — integração pendente |
| BET, LOSS e insuficiência preservam saldo/ledger | Sim — domínio e use case | Não — integração pendente |
| Constraints de não negatividade, imutabilidade e FKs | Sim — migration SQL nomeada | Não — integração pendente |
| Runner suporta `up`, `up`, `down`, `up` | Sim — manifest + marcador transacional | Não — integração pendente |

## Entrega B — eventos e processamento distribuído

| Requisito | Implementado | Validado |
| --- | --- | --- |
| Eventos de integração tipados/versionados | Sim — `IntegrationEvent<T>` e subclasses concretas | Não — testes unitários pendentes |
| Envelope de comando SQS versionado | Sim — consumer exige `version: 1` | Não — integração SQS pendente |
| Inbox persistente e ack só pós-commit | Sim — Inbox/financeiro/outbox no mesmo commit; ack posterior | Não — redelivery real pendente |
| DLQ permanente e retry transitório | Sim — cópia DLQ antes do ack, visibility backoff e limite | Não — integração SQS pendente |
| Shutdown seguro | Sim — interrompe polling, aguarda drain e devolve visibilidade | Não — sinal real pendente |
| Outbox com leases concorrentes | Sim — migration `0002`, `SKIP LOCKED`, token e expiração | Não — dois publishers reais pendentes |
| Referência fora de ordem/reinício | Sim — estado durável, TTL, backoff e worker retomável | Não — integração pendente |
| Reconciliação ao final dos testes financeiros | Sim — `financial-core`, `distributed-delivery` e `process-crash-recovery` chamam reconciliação | Não — integrações pendentes |

## Entrega C — contratos HTTP, operação e observabilidade

| Requisito | Implementado | Validado |
| --- | --- | --- |
| DTOs HTTP e dinheiro decimal-string | Sim — DTOs com nested validation, whitelist e recusa de campos extras | Não — unitário/API real pendentes |
| Erros HTTP estáveis | Sim — filtro central retorna `code`, `message`, `correlationId`, `retryable` | Não — unitário/API real pendentes |
| Reconciliação completa | Sim — saldo persistido, soma assinada, diferença, quantidade, log e métrica de divergência | Não — integração pendente |
| Logs JSON correlacionados e sem payload financeiro | Sim — middleware + logger estruturado payload-safe | Não — unitário/processos reais pendentes |
| Métricas de negócio | Sim — transações, duplicatas, retries, DLQ, lock, outbox, latência e divergência em `/metrics` | Não — unitário/API real pendentes |
| Liveness/readiness real | Sim — readiness executa `SELECT 1` e consulta as três filas SQS | Não — API contra dependências reais pendente |
| Três ou mais processos independentes | Sim — Compose define API, consumer, dois publishers e pending worker | Não — teste de processos pendente |
| Crash pós-commit/pré-ack | Sim — hook guardado por `RUN_CRASH_TEST`; teste inicia consumer que sai com `86` | Não — integração de processos pendente |
| Dois publishers concorrentes | Sim — Compose e teste de processos usam dois `APP_INSTANCE_ID`s | Não — integração de processos pendente |
| Documentação operacional/arquitetural | Sim — `README.md`, `ARCHITECTURE.md`, guardrails e este status | Revisão estática concluída |

## Revisão da Definition of Done

| Item obrigatório | Estado |
| --- | --- |
| Dinheiro sem `number`/float/aproximação | Implementado; `Money`/PostgreSQL usam decimal string/`NUMERIC(20,2)`. Os `number` restantes são somente HTTP, contadores, tempos e métricas. Validação estática concluída. |
| Saldo nunca negativo sob concorrência | Implementado por lock por wallet, domínio e check SQL; teste de corrida já existe. Pendente execução real. |
| Idempotência persistente e efeito único | Implementado por chave, provider/external e Inbox no banco. Pendente execução real. |
| Ledger imutável e reconciliável | Implementado por FKs/checks/triggers e endpoint de reconciliação. Pendente execução real. |
| Evento não publicado antes do commit | Implementado por outbox na transação SQL; publisher assíncrono com lease. Pendente execução real. |
| Redelivery, DLQ, reinício e pending reference | Implementado com testes de integração reais. Pendente execução real. |
| DTOs, erros, logs, métricas e readiness | Implementado com testes unitários/processo escritos. Pendente execução real. |
| Três processos, crash pós-commit/pré-ack e dois publishers | Implementado no Compose e em `process-crash-recovery.test.ts`. Pendente execução real. |

## Verificações executadas nesta etapa

- [x] Inspeção manual de todos os arquivos alterados e novos da Entrega C.
- [x] Revisão estática dos contratos monetários: nenhum valor financeiro novo é
  convertido para `number`, `float`, `double`, `parseFloat` ou aproximação.
- [x] `git diff --check` — sem erro de whitespace (avisos de CRLF do Git não alteram o resultado).
- [x] `docker compose config --quiet` — exit code `0`; apenas aviso de permissão no `config.json` global do Docker.
- [ ] `bun run build`, `bun run lint`, `bun run format:check` — Bun ausente.
- [ ] testes unitários — Bun/dependências ausentes.
- [ ] integrações PostgreSQL/SQS e processos — Bun ausente e daemon Docker indisponível.

## Evidência de bloqueio local e comandos exatos de validação posterior

Evidência observada nesta máquina:

```text
bun: The term 'bun' is not recognized as the name of a cmdlet, function, script file, or operable program.
docker: failed to connect to the docker API at npipe:////./pipe/docker_engine
```

Quando Bun, `node_modules`, Docker daemon, PostgreSQL e LocalStack estiverem
disponíveis, executar exatamente no PowerShell:

```bash
docker compose up -d --build
docker compose ps
bun run build
bun run lint
bun run format:check
bun run test:unit
$env:RUN_INTEGRATION='true'
bun test test/integration/migrations.test.ts
bun test test/integration/schema-guardrails.test.ts
bun test test/integration/financial-core.test.ts
bun test test/integration/distributed-delivery.test.ts
bun test test/integration/process-crash-recovery.test.ts
bun test test/unit test/integration
Remove-Item Env:RUN_INTEGRATION
curl.exe -i http://localhost:3000/health/live
curl.exe -i http://localhost:3000/health/ready
curl.exe -s http://localhost:3000/metrics
docker compose logs --no-color api sqs-consumer outbox-publisher-a outbox-publisher-b pending-worker
```

Para conferir a execução do cenário de falha, o teste de processo deve observar
o exit code `86` do consumer de crash e terminar com saldo/reconciliação
`75.00`, dois lançamentos de ledger, uma Inbox e quatro eventos publicados.

## P0 que impedem declarar pronto

- [ ] Aprovar build, lint, format e todos os unitários no runtime Bun.
- [ ] Aprovar migrations, constraints, atomicidade e concorrência em PostgreSQL real.
- [ ] Aprovar consumer SQS, redelivery, retry/DLQ, pending reference e shutdown com LocalStack real.
- [ ] Aprovar os quatro processos reais, o crash pós-commit/pré-ack e os dois publishers concorrentes.
- [ ] Aprovar a reconciliação final em cada teste financeiro executado.

Não há requisito de código conhecido não implementado nesta etapa; os itens P0
acima são exclusivamente validações dinâmicas ainda indisponíveis localmente.
