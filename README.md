# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores por **HTTP** e por **SQS FIFO**. O serviço continua correto com mensagens duplicadas, fora de ordem ou processadas simultaneamente por várias instâncias.

- Dinheiro exato (`bigint` em centavos no domínio, `numeric(20,2)` no banco, string decimal nos contratos).
- Uma transação SQL por operação: lock da wallet (`FOR UPDATE`) + update condicionado por versão + ledger imutável + inbox + outbox.
- Idempotência só persistente (inbox, `Idempotency-Key`, `(provider, externalTransactionId)`).
- Invariantes garantidas **no schema** (constraints, índices parciais, triggers, constraint triggers deferred).
- Referências fora de ordem resolvidas por worker com backoff; transactional outbox com publishers concorrentes.

Stack: Bun 1.4 · TypeScript estrito · NestJS 12 · MikroORM 7 · PostgreSQL 18 · SQS via MiniStack · Docker Compose.

As decisões, os trade-offs, os contratos de referência e as limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Requisitos

- Docker com Compose v2.
- [Bun](https://bun.sh) **1.4.3**, só para rodar os testes ou a aplicação fora do Docker.

## Subir tudo

```sh
docker compose up -d --build --wait
```

| Serviço | Papel |
|---|---|
| `postgres`, `ministack` | PostgreSQL 18 e SQS (MiniStack, porta 4566) |
| `keycloak` | só com `--profile auth`: IdP para `AUTH_MODE=keycloak` (porta 8080) |
| `migrate` | one-shot: aplica as migrations (como dono do schema) e dá login ao role `wagering_app`, com que as réplicas conectam |
| `queues` | one-shot: cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo` |
| `app` ×3 | réplicas com todos os papéis (API, consumidor SQS, outbox publisher, worker de referências) |
| `nginx` | balanceia as réplicas em **http://localhost:3000** |

Para derrubar: `docker compose down` (com `-v` para apagar os dados).

## Exemplos

```sh
# criar wallet (saldo inicial > 0 gera a transação interna OPENING e o lançamento de crédito)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# → 201 {"id":"<walletId>","playerId":"0192f28f-…","balance":{"amount":"1000.00","currency":"BRL"},"version":1,…}

# apostar (Idempotency-Key obrigatório)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
# → 200 {"transactionId":"…","status":"PROCESSED","failureCode":null,"balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# repetir o mesmo comando → mesma resposta com "idempotentReplay":true
# mesma key com outro payload → 409 IDEMPOTENCY_KEY_REUSED

# estorno que chega antes da aposta → 202 PENDING_REFERENCE; o worker resolve quando a BET chegar
#   (kind "REFUND", "referenceExternalTransactionId":"<externalTransactionId da BET>", mesmo valor e rodada)

# consultas
curl -s localhost:3000/wallets/<walletId>
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50'          # cursor opaco em nextCursor
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123

# reconciliação (saldo materializado × ledger; divergência é sinalizada, logada e contada, nunca corrigida)
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

# canal SQS: publica uma WagerTransactionRequested na fila de entrada
bun run sqs:send <walletId> <playerId> BET 12.50

# operação
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready      # Postgres + SQS; 503 durante o shutdown
curl -s localhost:3000/metrics           # Prometheus (cada requisição cai numa réplica)
```

Os status HTTP, o envelope de erro, os códigos de falha e os eventos publicados estão documentados no ARCHITECTURE (§12–§14).

### Autenticação (opcional)

Por padrão a API não exige credenciais. Para exigir um token por provedor (Keycloak, `client_credentials`):

```sh
AUTH_MODE=keycloak docker compose --profile auth up -d --build --wait
TOKEN=$(curl -s localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)
curl -s localhost:3000/wallets/<walletId> -H "authorization: Bearer $TOKEN"
```

Clients `provider-a` e `provider-b` (segredos de desenvolvimento no realm importado). Sem token → 401; um provedor agindo por outro → 403. Detalhes no ARCHITECTURE §16.

## Desenvolvimento local

```sh
bun install
docker compose up -d --wait postgres ministack && bun run sqs:create-queues
cp .env.example .env                     # o Bun carrega .env automaticamente
bun run migrate:up
bun run dev                              # http://localhost:3000, com reload
```

## Testes

Os testes de integração e concorrência usam **PostgreSQL e MiniStack reais**. Suba a infraestrutura antes:

```sh
docker compose up -d --wait postgres ministack && bun run sqs:create-queues
```

| Comando | O que roda |
|---|---|
| `bun test` | tudo (≈ 1–2 min) |
| `bun run test:unit` | domínio puro (Money, Wallet, regras, máquina de estados, payload hash) |
| `bun run test:integration` | schema e migrations, persistência, HTTP, atomicidade, inbox, consumidor SQS e DLQ, outbox, referências pendentes, observabilidade, shutdown |
| `bun run test:concurrency` | 50 apostas idênticas, disputa de saldo, reversões concorrentes, wallets em paralelo, 3 processos, crash entre commit e ack, `SIGKILL` sob carga |
| `bun run test:load` | teste de carga (hot wallet × 100 wallets, 3 instâncias reais; pare as réplicas do compose antes, com `docker compose stop app nginx`, para não disputarem CPU); relatório em `test/load/results/` e análise no ARCHITECTURE §21 |

Cada arquivo de teste usa um banco próprio, clonado de um template migrado, e filas com nome aleatório. Os testes de concorrência sobem processos reais (`bun src/main.ts`). Todo teste de integração e concorrência termina verificando `saldo da wallet == saldo reconstruído pelo ledger`.

Qualidade: `bun run typecheck` · `bun run lint` · `bun run format`. O CI (`.github/workflows/ci.yml`) roda lint, typecheck e `bun test` com Postgres e MiniStack.

## Scripts

| Script | Uso |
|---|---|
| `dev` / `start` | aplicação com/sem reload |
| `migrate:up` / `migrate:down` | migrations (`bun run migrate:down -- --to 0` desfaz todas) |
| `sqs:create-queues` | cria as filas (idempotente) |
| `sqs:send` | publica uma mensagem de exemplo na fila de entrada |
| `test`, `test:unit`, `test:integration`, `test:concurrency` | suítes |
| `test:load` | teste de carga (`LOAD_CONCURRENCY`, `LOAD_RATE`, `LOAD_DURATION_S`, `LOAD_WALLETS`, `LOAD_OUTBOX_INSTANCES`, `LOAD_SCENARIOS`…) |
| `typecheck`, `lint`, `format` | qualidade |

## Estrutura

```
src/
  main.ts, app.ts, app.module.ts   bootstrap (sinais tratados no main), composição dos módulos
  config/                          variáveis de ambiente (zod)
  shared/                          Money, erros, portas (UnitOfWork, Metrics, Clock), infra (ORM, SQS, logs, métricas), HTTP
  wallet/                          wallet, ledger, abertura, consultas, reconciliação
  wagering/                        transações, regras, ProcessWagerTransaction, worker de referências, consumidor SQS
  messaging/                       eventos de integração, inbox/outbox, publisher
  health/                          /health/live, /health/ready, /metrics
migrations/                        SQL escrito à mão (up/down)
scripts/                           migrate, criação de filas, envio de mensagem
test/{unit,integration,concurrency,load,support}
```
