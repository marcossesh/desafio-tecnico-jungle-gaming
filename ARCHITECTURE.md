# ARCHITECTURE — Distributed Wagering Processor

Decisões técnicas, trade-offs, interpretações e limitações do serviço. Setup e comandos estão no [README](README.md).

---

## 1. Visão geral

```
                ┌──────────── Provedores ────────────┐
                │  HTTP (Idempotency-Key)    SQS FIFO │
                └──────┬─────────────────────────┬───┘
                       │                         │ wager-transactions.fifo
                       ▼                         ▼            (DLQ: wager-transactions-dlq.fifo)
     ┌─────────────────────────── instância N (×3) ──────────────────────────┐
     │  HTTP Controller      SqsConsumer (inbox)                             │
     │         └────────┬────────┘                                            │
     │                  ▼                                                     │
     │        ProcessWagerTransaction  ◄── ReprocessPendingReferences (worker)│
     │                  │                                                     │
     │     ┌────────────┴──────── 1 transação SQL ────────────────────┐       │
     │     │ inbox · wallet (FOR UPDATE) · wager_tx · ledger · outbox │       │
     │     └──────────────────────────────────────────────────────────┘       │
     │                                       PublishOutbox (lease) ───────────┼──► wagering-events.fifo
     └────────────────────────────────────────────────────────────────────────┘
                                       │
                                  PostgreSQL (invariantes no schema)
```

Todas as instâncias são idênticas e rodam todos os componentes; a variável `ROLES` (`api,consumer,outbox,scheduler`) permite separá-los. Nenhum componente depende de ser único: **o PostgreSQL é o único árbitro de consistência**. No compose, três réplicas ficam atrás de um nginx em `:3000`.

## 2. Stack e justificativas

| Item | Escolha | Por quê |
|---|---|---|
| Runtime | Bun 1.4 | obrigatório; `Bun.randomUUIDv7()`, `Bun.spawn` nos testes multi-processo, `Bun.SQL` nos testes de schema |
| Framework | NestJS 12 (express) | obrigatório; usado só nas bordas (HTTP, DI, ciclo de vida) |
| ORM | **MikroORM 7** com `EntitySchema` | preferencial; `em.transactional()`, `LockMode.PESSIMISTIC_WRITE`. `EntitySchema` evita decorators no domínio e problemas de metadata no Bun |
| Banco | PostgreSQL 18 | constraints, índices parciais, constraint triggers `DEFERRABLE`, `SKIP LOCKED` |
| Mensageria | SQS via **MiniStack** 1.5.30 | o enunciado permite LocalStack ou MiniStack. O **LocalStack foi avaliado e descartado**: desde a 2026.03 a imagem exige auth token (o plano gratuito Hobby inclui SQS, mas é só para uso não comercial, e avaliador e CI precisariam de conta), e ele tem um bug de visibilidade FIFO que afeta o backoff do consumidor (evidências em §21). O MiniStack sobe sem conta. Um spike virou teste (`sqs-emulator.test.ts`): ordem por `MessageGroupId`, dedup, bloqueio de grupo em voo, `ApproximateReceiveCount`, redrive para DLQ FIFO e backoff de visibilidade |
| Validação | zod | sem decorators; o mesmo schema valida o corpo HTTP e o `data` da mensagem SQS |
| Logs / métricas | pino / prom-client | JSON estruturado; formato Prometheus em `/metrics` |

## 3. Camadas e portas

```
src/<módulo>/domain/        classes puras (Money, Wallet, WalletLedgerEntry, WagerTransaction, applyWager,
                            evaluateReference, IntegrationEvent, Inbox/OutboxMessage) — sem Nest/ORM/SDK
src/<módulo>/application/   casos de uso + portas (repositórios, UnitOfWork, Metrics, EventPublisher, Clock)
src/<módulo>/infra/         MikroORM (records + mappers + repositórios), SQS, workers
src/<módulo>/http/          controllers, schemas zod, presenters
```

Módulos: `wallet`, `wagering`, `messaging` e `shared`. O lint proíbe `@nestjs/*`, `@mikro-orm/*`, SDK, pino e zod em `domain/` e também `parseFloat`/`parseInt`.

- **Construtores privados + factories** (`create`/`open`/`enqueue`/`rehydrate`). `rehydrate` reconstrói estado persistido sem revalidar transições.
- **Persistência** com *records* separados do domínio (`EntitySchema`) e mappers explícitos. A reidratação sempre passa por `rehydrate`, e o Unit of Work do ORM nunca altera estado de domínio fora das transições. As gravações usam `em.insert`/`nativeUpdate`/`findOne({ lockMode })`, sem flush implícito.
- **`UnitOfWork.run(work, { isolation, readOnly, lockTimeoutMs })`**: entrega um `TransactionScope` com os cinco repositórios ligados à mesma transação SQL. Os casos de uso dependem só dessa porta. A implementação traduz erros do Postgres (§13).
- Casos de uso não usam decorators do Nest: os módulos os montam por factory. `Clock` e `IdGenerator` são injetados, e os workers expõem `runOnce()`.

## 4. Money

- **Interno:** `bigint` em centavos (escala fixa de 2 casas). Exato, sem dependência, aritmética trivial. Preferido a `decimal.js` porque, com escala fixa, um decimal arbitrário não traz ganho e abre espaço para arredondamento implícito.
- **Fronteira:** string decimal estrita (`^(0|[1-9]\d{0,17})(\.\d{1,2})?$`). **Nunca arredonda**: rejeita mais de 2 casas, `NaN`, `Infinity`, notação científica, string vazia e negativos (`INVALID_MONEY`). `"10"` é normalizado para `"10.00"`.
- **Banco:** `numeric(20,2)` (exato, `SUM` exato na reconciliação), com a moeda em coluna `char(3)` separada; o driver devolve string → `Money.from`. Como `numeric(20,2)` arredondaria silenciosamente na escrita, o domínio só envia strings já normalizadas.
- O modelo é multi-moeda (uma wallet por player+moeda); operar com moeda diferente da wallet é `CURRENCY_MISMATCH`.

## 5. Modelo de transação e regras

**Máquina de estados** (`PROCESSED`, `REJECTED` e `FAILED` são terminais; transicionar um terminal lança `InvalidTransactionStateError`, que é erro de programação):

```
PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa: attempts++)
```

`PENDING` só existe em memória: o fluxo síncrono persiste o resultado já decidido. `FAILED` (`PROCESSING_FAILED`) é erro permanente não-negócio no reprocessamento.

| Operação | Saldo | Ledger |
|---|---|---|
| `BET` | débito (rejeita sem saldo: `INSUFFICIENT_FUNDS`) | 1 `DEBIT` |
| `WIN` | crédito; pode referenciar a `BET` | 1 `CREDIT` |
| `LOSS` | nenhum (`amount ≥ 0`) | nenhum |
| `REFUND` | crédito; reverte uma `BET` | 1 `CREDIT` |
| `ROLLBACK` | inverso da referência (BET→crédito; WIN/REFUND→débito) | 1 lançamento invertido |

**Regras de referência** (`evaluateReference`). A referência é resolvida por `(providerId, referenceExternalTransactionId)`, logo vem sempre do mesmo provider:

| Condição | Resultado |
|---|---|
| ausente ou ainda `PENDING_REFERENCE` | `PENDING_REFERENCE` (202) |
| player, wallet, moeda ou rodada diferente | `REJECTED REFERENCE_MISMATCH` |
| `REFUND`→não-BET; `ROLLBACK`→∉{BET, WIN, REFUND}; `WIN`→não-BET | `REJECTED REFERENCE_KIND_NOT_ALLOWED` |
| referência `REJECTED`/`FAILED` | `REJECTED REFERENCE_NOT_PROCESSED` |
| valor ≠ valor da referência (reversões) | `REJECTED REFERENCE_AMOUNT_MISMATCH` |
| referência já revertida | `REJECTED REFERENCE_ALREADY_REVERSED` |
| reversão que deixaria saldo negativo | `REJECTED INSUFFICIENT_FUNDS_FOR_REVERSAL` (≠ `INSUFFICIENT_FUNDS`) |

## 6. Concorrência

**Unidade de concorrência = wallet.** A estratégia combina três camadas:

1. **Lock pessimista por linha:** `SELECT … FROM wallets WHERE id = $1 FOR UPDATE` no início da transação. Serializa as operações da mesma wallet entre todas as instâncias; wallets diferentes não competem, e não há lock global.
2. **Update condicionado por versão:** `UPDATE … WHERE id = $1 AND version = $expected`. Sob o lock, nunca deveria falhar; se falhar, é bug detectado (`ConcurrencyConflictError` → retry + métrica), nunca lost update silencioso.
3. **Constraints no schema** (§9): mesmo um bug na aplicação não produz saldo negativo nem saldo sem lançamento.

- **Por que pessimista e não só otimista:** o cenário crítico é a *hot wallet* (50 apostas idênticas, duas apostas disputando o mesmo saldo). Com optimistic locking, N concorrentes geram até N−1 conflitos por rodada e retries em cascata; com `FOR UPDATE`, eles enfileiram no Postgres e cada um faz uma tentativa. **Evidência:** removendo o `FOR UPDATE` (mutação de teste), o update condicionado ainda impede lost update, mas 100 apostas concorrentes numa wallet esgotam as 3 tentativas e viram `503`.
- **Por que não advisory locks:** exigiriam gerenciar chave e sessão manualmente. O row lock já existe, é liberado em commit, rollback ou queda de conexão e aparece em `pg_locks`.
- **Por que `READ COMMITTED`:** o lock de linha já dá a serialização necessária; `SERIALIZABLE` só adicionaria aborts `40001`. A reconciliação usa `REPEATABLE READ READ ONLY` para ler saldo e ledger no mesmo snapshot.
- **Livre de deadlock:** ordem fixa `inbox → wallet → wager_transactions da mesma wallet`; nenhuma operação toca duas wallets. `lock_timeout` (`WALLET_LOCK_TIMEOUT_MS`, 3s) transforma espera excessiva em erro transitório (`503 LOCK_TIMEOUT`; no SQS, a mensagem volta com backoff).
- **Retry interno:** até 3 tentativas para `55P03`/`40P01`/`40001`/conflito de versão e para corrida nas constraints de identidade, com espera `20ms·tentativa + jitter`.

## 7. Idempotência

Três camadas, todas **persistentes** (nada em memória):

| Camada | Garantia | Constraint |
|---|---|---|
| Inbox (SQS) | a mesma mensagem não reprocessa | PK `(consumer_name, message_id)` |
| `Idempotency-Key` (fonte da verdade) | mesma operação → mesmo resultado | `UNIQUE (idempotency_key)` |
| Identidade de negócio | um `externalTransactionId` por provider | `UNIQUE (provider_id, external_transaction_id)` |

- **Payload hash:** `hex(SHA-256(canonicalJson(subset)))`, onde `subset = { providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money: { amount (normalizado a 2 casas), currency }, referenceExternalTransactionId (ou null) }`. O JSON canônico tem chaves ordenadas recursivamente, sem espaços, com strings escapadas por `JSON.stringify`. Ficam fora do hash: `idempotencyKey`, headers, `messageId`, `occurredAt`, `type`. O hash é idêntico em HTTP e SQS, então um replay cruzado entre canais funciona.
- **Replay:** mesma key e mesmo hash devolvem o resultado persistido (`status`, `failureCode`, `balance` = **saldo observado naquele momento**), com `idempotentReplay: true` e o mesmo status HTTP. Mesma key com hash diferente → `409 IDEMPOTENCY_KEY_REUSED`. Key nova para `(provider, externalTransactionId)` existente → `409 EXTERNAL_TRANSACTION_ID_REUSED`. Em nenhum desses casos algo é gravado.
- **Corrida de duplicatas:** na mesma wallet, as duplicatas serializam no lock — a primeira insere e as demais encontram a linha. Entre wallets diferentes (payload adulterado), colidem no índice único; o caso de uso captura o `23505`, tenta de novo e a nova tentativa encontra a linha vencedora.
- A deduplicação do SQS FIFO é otimização, nunca a garantia.

## 8. Fluxo de processamento

`ProcessWagerTransaction` é o **único** caminho de escrita para HTTP e SQS. Um payload inválido falha antes de abrir transação. Dentro de uma transação SQL:

1. (SQS) `INSERT inbox … ON CONFLICT DO NOTHING`; se já existia: payload diferente → `INBOX_PAYLOAD_MISMATCH` (permanente), igual → `duplicate_message` (ack sem efeito).
2. `SELECT wallet FOR UPDATE` (ausente → `WALLET_NOT_FOUND`, rollback inclusive da inbox).
3. Idempotência (§7) → replay ou 409.
4. Resolve a referência e checa se ela já foi revertida → `applyWager` (domínio puro) decide `PROCESSED` (com lançamento opcional), `REJECTED(code)` ou `PENDING_REFERENCE`.
5. `INSERT wager_transactions`; se houver lançamento: `INSERT ledger` + `UPDATE wallets … WHERE version = $expected`.
6. `INSERT outbox` com os eventos (§14).
7. Se `PROCESSED`: "acorda" as transações `PENDING_REFERENCE` que esperavam por ela (`next_reference_check_at = now`).
8. Commit. Só então: resposta HTTP / ack SQS / publicação pelo outbox.

`POST /wallets` usa uma transação: wallet (`version = 1`) + (se o saldo inicial for > 0) transação `OPENING` `PROCESSED` + lançamento `CREDIT` na versão 1 + evento `WalletBalanceChanged`.

## 9. Invariantes no schema

As garantias de unicidade, imutabilidade e não-negatividade valem no banco, independentemente do código.

| Invariante | Mecanismo |
|---|---|
| 1 wallet por player+moeda | `UNIQUE (player_id, currency)` |
| saldo ≥ 0 | `CHECK (balance >= 0)` + `CHECK` em `balance_before/after` |
| aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)`, `amount > 0` |
| moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency) → wallets(id, currency)` |
| lançamento pertence a uma transação da mesma wallet | FK composta `(transaction_id, wallet_id)` |
| ≤ 1 lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| cadeia sem buracos | `UNIQUE (wallet_id, wallet_version)` + trigger: `balance_before = balance_after` do anterior |
| `version` nasce em 1 e muda ⇔ saldo muda | trigger `BEFORE INSERT OR UPDATE` em `wallets` |
| toda mudança de saldo tem lançamento | **constraint trigger `DEFERRABLE INITIALLY DEFERRED`** (checa no commit) |
| todo lançamento tem mudança de saldo, de transação `PROCESSED` ≠ `LOSS` | constraint trigger deferred em `wallet_ledger_entries` |
| ledger imutável | trigger contra `UPDATE`/`DELETE`/`TRUNCATE` |
| transação terminal imutável; colunas de negócio imutáveis | trigger em `wager_transactions` |
| uma reversão processada por referência | índice único parcial `WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| `OPENING` só interno e 1 por wallet | `CHECK ((kind = 'OPENING') = (provider_id = 'internal'))` + índice único parcial |

- **Migrations:** SQL escrito à mão (MikroORM Migrator, `up`/`down`), porque triggers e índices parciais não sairiam corretos de um diff de schema. Migrator programático com `migrationsList` explícito, executado pelo serviço one-shot `migrate` antes das réplicas.
- **Nomes e erros:** as constraints têm nome explícito. Violações de trigger usam SQLSTATE `23000` (bug do chamador, não erro de negócio).
- **Testes:** `schema.test.ts` executa `up → down → up` e prova cada invariante em SQL cru, sem passar pela aplicação.

## 10. Referências fora de ordem

- Referência ausente (ou ainda pendente) → `PENDING_REFERENCE`, resposta `202` e evento `WagerTransactionPendingReference`.
- Quando a referência é processada, o mesmo commit acorda os dependentes. A resolução sai em ~1 ciclo do worker, em vez de esperar o backoff.
- **Worker** (`ReprocessPendingReferences`, papel `scheduler`, todas as instâncias):
  - O claim é uma única instrução (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`) que já grava um lease de 30s; se o processo morrer, o item só atrasa.
  - Depois, uma transação por item: lock da wallet, lock da transação, nova checagem do status (item já resolvido por outra instância é ignorado), `applyWager` e os mesmos efeitos de §8.
- **Limite:** backoff exponencial de 2s até o teto de 5 min, com ±20% de jitter, e **10 tentativas (~15 min)**. Provedores reenviam REFUND/ROLLBACK em segundos ou minutos; uma janela maior deixaria dinheiro "em suspenso" sem benefício. Esgotado o limite → `REJECTED REFERENCE_NOT_FOUND` + `WagerTransactionRejected`. Tentativas sem sucesso não geram evento. Tudo configurável (`PENDING_REF_*`).
- **Erros:** um erro inesperado num item consome tentativa do mesmo orçamento; esgotado → `FAILED PROCESSING_FAILED`, auditável e sem evento, o que evita um item problemático para sempre. Um erro transitório não consome tentativa: o lease já reagenda.

## 11. Mensageria e falhas

### Consumidor SQS (papel `consumer`)

- Long polling (20s, até 10 mensagens). Grupos (`MessageGroupId = walletId`) em paralelo; mensagens do mesmo grupo, em sequência. A ordem é otimização — a correção vem do lock e das referências pendentes.
- Ack (`DeleteMessage`) **somente após o commit**. Se a instância morrer entre o commit e o ack, a mensagem é reentregue e a inbox a reconhece → ack sem efeito.

| Resultado | Classe | Ação |
|---|---|---|
| novo, replay, duplicata, `REJECTED`, `PENDING_REFERENCE` | negócio | `DeleteMessage` |
| envelope/payload inválido, `INVALID_MONEY`, `KIND_NOT_ALLOWED`, conflitos de idempotência, `WALLET_NOT_FOUND`, `INBOX_PAYLOAD_MISMATCH` | permanente | DLQ explícita (atributos `failureCode`, `originalMessageId`, `receiveCount`) + delete |
| `LOCK_TIMEOUT`, `SERVICE_UNAVAILABLE`, erro inesperado | transitório | `ChangeMessageVisibility(min(2^(recebimentos−1) · SQS_RETRY_BASE_SECONDS, 900s))`; DLQ ao atingir `SQS_MAX_ATTEMPTS` |

- A redrive policy da fila (`maxReceiveCount = SQS_MAX_ATTEMPTS + 1`) é a rede de segurança para crash loops.
- **SIGTERM:** para de receber (aborta o long poll), conclui a mensagem em andamento dentro de `SHUTDOWN_GRACE_MS` e devolve imediatamente (`ChangeMessageVisibility(0)`) as que ainda não começaram.
- **Sinais:** são tratados no `main.ts` (`app.close()` → `process.exit`), não com `enableShutdownHooks`. O Nest reenvia o sinal a si mesmo depois do close e, como PID 1 no container, o Bun o ignora; o processo só saía quando um timer de grace vencia (25s). Coberto por `shutdown.test.ts` (processo real: exit 0 em < 5s). Os workers param em `beforeApplicationShutdown`, antes de o pool e o cliente SQS fecharem.

### Transactional outbox (papel `outbox`)

- O evento é gravado na mesma transação da mudança financeira: nunca é publicado antes do commit e nunca se perde depois dele.
- **Lease em vez de transação aberta:** o publisher reserva até 100 eventos com lease (`locked_until`, `OUTBOX_LEASE_MS`) numa transação curta (índice parcial em `seq` dos não publicados) e publica fora dela, em `SendMessageBatch` de 10 (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`), com partições distribuídas em 5 faixas paralelas que preservam a ordem por wallet. Enquanto os lotes vêm cheios, drena no mesmo ciclo. Nenhuma conexão ou lock fica preso durante I/O de rede. Depois de um crash, outra instância assume quando o lease expira.
- **Sucesso e falha:** em caso de sucesso, `published_at` (a marcação é idempotente e não sobrescreve o que outra instância já publicou). Em caso de falha (do lote ou de entradas individuais), backoff de 1s até 5 min, **sem limite de tentativas** — evento confirmado nunca é descartado.
- Duplicatas são esperadas e seguras: os consumidores deduplicam por `eventId` (a dedup do FIFO é uma janela de 5 min).
- O cliente SQS tem `connectionTimeout` 3s e `requestTimeout` 30s com `throwOnRequestTimeout` (sem isso, o SDK só emite um aviso e a chamada fica presa). Testado com o MiniStack **pausado**.

## 12. API HTTP

| Método | Rota | Sucesso | Notas |
|---|---|---|---|
| `POST` | `/wallets` | 201 | `409 WALLET_ALREADY_EXISTS` para player+moeda repetido |
| `GET` | `/wallets/:walletId` | 200 | `{ id, playerId, balance, version, createdAt, updatedAt }` |
| `GET` | `/wallets/:walletId/ledger?cursor&limit` | 200 | `{ items, nextCursor }`, `wallet_version DESC`, `limit` 1..200 (padrão 50); cursor opaco = base64url de `{"v": wallet_version}`, estável porque o ledger é append-only |
| `POST` | `/wallets/:walletId/reconciliation` | 200 | consistente ou não; `issues[]` ⊂ `BALANCE_MISMATCH`, `LAST_ENTRY_MISMATCH`, `VERSION_MISMATCH`, `LEDGER_CHAIN_BROKEN` |
| `POST` | `/wagering/transactions` | 200 / 202 / 422 | header `Idempotency-Key` obrigatório (1..200); `X-Correlation-Id` opcional |
| `GET` | `/wagering/transactions/:transactionId` | 200 | visão completa |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | idem |
| `GET` | `/health/live`, `/health/ready` | 200 / 503 | §15 |
| `GET` | `/metrics` | 200 | Prometheus |

**Mapeamento de status** (consistente em todos os endpoints):

| Situação | Status | `retryable` |
|---|---|---|
| `PROCESSED` (novo ou replay) | 200 | — |
| `PENDING_REFERENCE` (aceito, processamento pendente) | 202 | — |
| payload ou header inválido, `OPENING` submetido, id de URL não-UUID | 400 | false |
| sem identidade / provedor divergente (com autenticação habilitada) | 401 / 403 | false |
| recurso da URL inexistente | 404 | false |
| conflito de idempotência / wallet duplicada | 409 | false |
| `REJECTED` por regra de negócio (novo ou replay); `WALLET_NOT_FOUND` no POST de transação | 422 | false |
| falha transitória (lock, Postgres, SQS) | 503 + `Retry-After` | true |
| erro inesperado | 500 | true |

O provedor decide pelo status: 2xx terminou ou foi aceito; 4xx não deve reenviar a mesma requisição; 5xx pode reenviar com a **mesma** `Idempotency-Key`, o que é seguro por construção. Erros seguem um envelope único:

```json
{ "error": { "code": "IDEMPOTENCY_KEY_REUSED", "message": "...", "retryable": false, "details": {} }, "correlationId": "..." }
```

O resultado de uma transação (200/202/422) é `{ transactionId, status, failureCode, balance, idempotentReplay }`.

## 13. Códigos de falha

| Código | Onde | HTTP | Persistido | Ação do provedor |
|---|---|---|---|---|
| `VALIDATION_ERROR` | payload/headers/URL inválidos | 400 | não | corrigir |
| `INVALID_MONEY` | `amount`/`currency` inválidos | 400 | não | corrigir |
| `IDEMPOTENCY_KEY_REQUIRED` | header ausente | 400 | não | enviar header |
| `KIND_NOT_ALLOWED` | `OPENING` submetido | 400 | não | não reenviar |
| `UNAUTHENTICATED` / `PROVIDER_MISMATCH` | autenticação habilitada | 401 / 403 | não | corrigir credencial |
| `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | GET de recurso inexistente | 404 | não | — |
| `IDEMPOTENCY_KEY_REUSED` | mesma key, payload diferente | 409 | não | nova key / investigar |
| `EXTERNAL_TRANSACTION_ID_REUSED` | `(provider, externalTransactionId)` com outra key | 409 | não | investigar |
| `WALLET_ALREADY_EXISTS` | player+moeda repetido | 409 | não | usar a existente |
| `WALLET_NOT_FOUND` | wallet do payload inexistente (POST de transação) | 422 | não | corrigir |
| `INSUFFICIENT_FUNDS` | BET sem saldo | 422 | **sim** | desistir |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | reversão que deixaria saldo negativo | 422 | **sim** | escalar para operação |
| `BALANCE_LIMIT_EXCEEDED` | crédito que passaria do teto de `numeric(20,2)` (§19) | 422 | **sim** | escalar para operação |
| `CURRENCY_MISMATCH` / `WALLET_PLAYER_MISMATCH` | moeda ou dono divergente | 422 | **sim** | corrigir com nova key |
| `REFERENCE_MISMATCH` / `REFERENCE_KIND_NOT_ALLOWED` / `REFERENCE_AMOUNT_MISMATCH` | §5 | 422 | **sim** | corrigir |
| `REFERENCE_NOT_PROCESSED` / `REFERENCE_ALREADY_REVERSED` | §5 | 422 | **sim** | desistir |
| `REFERENCE_NOT_FOUND` | referência não chegou no prazo (§10) | 422 na consulta | **sim** | desistir / reconciliar |
| `PROCESSING_FAILED` | `FAILED` no worker | 422 na consulta | **sim** | contatar operação |
| `INBOX_PAYLOAD_MISMATCH` | mesmo `messageId` SQS com outro payload | DLQ | não | investigar o produtor |
| `LOCK_TIMEOUT` / `SERVICE_UNAVAILABLE` | disputa de lock / Postgres ou SQS indisponível | 503 | não | **reenviar** com a mesma key |
| `INTERNAL_ERROR` | bug | 500 | não | reenviar com a mesma key |

Tradução de erros do Postgres: `23505` vira erro com o nome da constraint (os casos de uso convertem as esperadas: wallet duplicada, corrida de idempotência); `55P03`/`40P01`/`40001` → `LOCK_TIMEOUT`; classe `08`, `57P0x` e erros de socket ou pool → `SERVICE_UNAVAILABLE`; o resto (`23514`, `23000`…) é bug → 500.

## 14. Eventos de integração

`IntegrationEvent<T>` é abstrata, com uma subclasse por evento (`eventType` e `version` ficam no tipo); `data` só tem tipos JSON (`MoneyProps`, ISO strings). O envelope é `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt, version, data }`.

| Evento | Quando | `aggregateId` |
|---|---|---|
| `WagerTransactionProcessed` v1 | qualquer `PROCESSED` (inclui `LOSS`; exclui `OPENING`) | transactionId |
| `WagerTransactionRejected` v1 | `REJECTED` (inclui `REFERENCE_NOT_FOUND`) | transactionId |
| `WagerTransactionPendingReference` v1 | entrada em `PENDING_REFERENCE` | transactionId |
| `WalletBalanceChanged` v1 | **somente** quando há lançamento (inclui `OPENING`) | walletId |

`partition_key = walletId` para todos (ordem por wallet no FIFO). O `correlationId` é propagado da entrada. O `causationId` é o `messageId` (SQS) ou o id da transação pendente (worker); no HTTP fica ausente, porque o `correlationId` já identifica a requisição. Um replay não gera eventos.

## 15. Observabilidade

- **Logs:** pino em JSON. O contexto vive num `AsyncLocalStorage` e é anexado a toda linha pelo `mixin` (`correlationId`, `channel`, `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`, `durationMs`). As bordas abrem e enriquecem o contexto: o middleware HTTP (que também registra uma linha `http request` por requisição, exceto `/health` e `/metrics`), o consumidor (um contexto por mensagem) e os workers (um por ciclo). Os casos de uso não conhecem o mecanismo. Valores e saldos nunca entram nos campos de log (um teste verifica); há redação de `money`, `balance*` e `authorization` como rede de segurança.
- **Métricas** (`/metrics`; apenas métricas próprias):

| Métrica | Tipo | Labels |
|---|---|---|
| `wager_transactions_total` | counter | `kind`, `status`, `channel` (`http`/`sqs`/`worker`) |
| `wager_processing_duration_seconds` | histogram | `kind`, `channel`, `outcome` (`new`/`replay`/`duplicate`/`error`) |
| `idempotent_replays_total` | counter | `channel` |
| `idempotency_conflicts_total` | counter | `code` |
| `inbox_duplicates_total` | counter | `consumer` |
| `wallet_lock_conflicts_total` | counter | `reason` (`lock_timeout`, `deadlock`, `serialization`, `version_conflict`) |
| `processing_retries_total` | counter | `component`, `reason` |
| `sqs_messages_total` | counter | `outcome` (`ack`, `retry`, `dlq`) |
| `sqs_dlq_messages_total` | counter | `reason` |
| `sqs_dlq_depth` | gauge | — |
| `pending_reference_transactions` | gauge | — |
| `outbox_pending_messages`, `outbox_lag_seconds` | gauge | — |
| `outbox_publish_delay_seconds` | histogram | — |
| `outbox_publish_failures_total` | counter | — |
| `reconciliation_divergences_total` | counter | — |

- **Health:** `/health/live` indica só que o processo responde. `/health/ready` testa o Postgres (`SELECT 1`) e o SQS (`GetQueueUrl`), com timeout de 1s cada, e responde **503 durante o shutdown**, para o balanceador tirar a instância antes de ela parar. Ambos ficam sem autenticação.
- **Reconciliação:** recalcula o saldo pelo ledger num snapshot único e verifica o último `balance_after`, a versão e a cadeia. Uma divergência é logada (sem valores), contada em `reconciliation_divergences_total` e sinalizada em `consistent: false` + `issues`. **Nunca é corrigida.**

## 16. Autenticação

**Decisão:** não implementada. Não pontua e competiria com o núcleo financeiro. O ponto de extensão está explícito no código:

- `ProviderIdentityPort.resolve(request) → ProviderIdentity | null` (`src/shared/http/provider-identity.ts`), com a implementação `AnonymousProviderIdentity` (`AUTH_MODE=none`, único modo aceito).
- `ProviderAuthGuard` global: libera `/health/*` e `/metrics`; sem identidade → `401 UNAUTHENTICATED`; `providerId` do corpo ou da rota diferente do da identidade → `403 PROVIDER_MISMATCH`.

**Desenho, se implementada:** Keycloak no compose; um client *confidential* por provedor com `client_credentials`; JWT com claim `provider_id`. Uma nova implementação de `ProviderIdentityPort` valida assinatura via JWKS (`jose`, com cache de chaves), `iss`, `aud` e `exp`, e o guard existente já aplica a regra `provider_id === providerId`. Mensagens SQS são canal interno confiável, mas o `providerId` delas continua sujeito às validações de domínio.

## 17. Configuração

Variáveis de ambiente, validadas com zod no boot. A app não sobe com valor inválido.

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | 3000 | HTTP (`0` = porta livre; a porta real é logada) |
| `ROLES` | `api,consumer,outbox,scheduler` | componentes ativos na instância |
| `LOG_LEVEL` | `info` | |
| `SHUTDOWN_GRACE_MS` | 25000 | drain no SIGTERM (compose: `stop_grace_period: 30s`) |
| `DATABASE_URL` | — (obrigatória) | Postgres |
| `DB_POOL_MAX` | 10 | pool por instância |
| `WALLET_LOCK_TIMEOUT_MS` | 3000 | `lock_timeout` da transação |
| `SQS_ENDPOINT` | — (obrigatória) | MiniStack/SQS |
| `AWS_REGION` | `us-east-1` | (credenciais pelas variáveis padrão da AWS) |
| `SQS_INPUT_QUEUE` / `SQS_DLQ_QUEUE` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events.fifo` | filas |
| `SQS_MAX_ATTEMPTS` | 5 | recebimentos com falha transitória antes da DLQ |
| `SQS_RETRY_BASE_SECONDS` | 2 | base do backoff de visibilidade |
| `OUTBOX_TICK_MS` / `OUTBOX_LEASE_MS` | 500 / 30000 | publisher |
| `PENDING_REF_TICK_MS` / `PENDING_REF_BASE_MS` / `PENDING_REF_CAP_MS` / `PENDING_REF_MAX_ATTEMPTS` | 1000 / 2000 / 300000 / 10 | worker de referências |
| `AUTH_MODE` | `none` | §16 |
| `FAILPOINTS` | vazio | só testes (`process.beforeCommit`, `reprocess.beforeCommit`, `consumer.afterCommitBeforeAck`) |

## 18. Testes

- **Unidade:** domínio puro, sem I/O.
- **Integração:** Postgres e MiniStack reais, sem mocks de banco ou fila.
  - Cada arquivo recebe um banco isolado (`CREATE DATABASE … TEMPLATE` de um template migrado uma vez por processo, sob advisory lock) e filas com sufixo aleatório.
  - As asserções de schema usam SQL cru via `Bun.SQL`, independente do ORM.
- **Concorrência:** paralelismo real.
  - Várias instâncias Nest com pools próprios, ou **processos separados** (`Bun.spawn` de `src/main.ts`).
  - Crash por *failpoint* (`process.exit(137)` entre o commit e o ack) e `SIGKILL` aleatório sob carga, com respawn.
  - O cliente de teste se comporta como um provedor: em erro de rede ou 503, reenvia a mesma `Idempotency-Key` para outra instância.
- **Determinismo:** os workers expõem `runOnce()` e recebem `Clock` (os testes avançam o tempo em vez de dormir). Cenários eventuais esperam por condição (`waitFor`), nunca por sleep fixo. O cenário obrigatório da §8 do desafio passou com `--rerun-each 20`.
- **Mutações:** cada fase foi validada quebrando o código de propósito (por exemplo, sem `FOR UPDATE`, ack antes do commit, sem lease) e confirmando que algum teste falha.
- **Invariante final de todo teste de integração e concorrência:** `assertLedgerConsistent()` — para cada wallet, `balance = Σ ledger`, `version = última versão do ledger` e `balance = último balance_after`.

| Exigência do desafio (§13) | Arquivo |
|---|---|
| Money: escala, arredondamento, entradas inválidas | `test/unit/money.test.ts` |
| invariantes da Wallet; conflito de moeda | `test/unit/wallet.test.ts`, `test/unit/wager-applier.test.ts` |
| regras de BET/WIN/LOSS/REFUND/ROLLBACK; máquina de estados | `test/unit/wager-applier.test.ts`, `test/unit/wager-transaction.test.ts` |
| idempotency key com payload divergente | `test/unit/payload-hash.test.ts`, `test/integration/wager-transactions.test.ts` |
| migrations e constraints | `test/integration/schema.test.ts` |
| atomicidade entre wallet, ledger, inbox e outbox | `test/integration/atomicity.test.ts` |
| inbox e redelivery | `test/integration/inbox.test.ts`, `test/integration/sqs-consumer.test.ts` |
| publishers concorrentes sobre a mesma outbox | `test/integration/outbox-publisher.test.ts` |
| retry e DLQ | `test/integration/sqs-consumer.test.ts` |
| recuperação após reinicialização | `test/integration/shutdown.test.ts`, `test/concurrency/crash-before-ack.test.ts`, `test/concurrency/restart-consistency.test.ts` |
| 1. mesma aposta 50× em paralelo | `test/concurrency/duplicate-bet.test.ts` |
| 2. disputa de saldo (100 vs 2×80) | `test/concurrency/balance-race.test.ts` |
| reversões concorrentes da mesma referência (no máximo uma) | `test/concurrency/reversal-race.test.ts` |
| 3. wallets distintas em paralelo | `test/concurrency/parallel-wallets.test.ts` |
| 4. ≥ 3 processos simultâneos | `test/concurrency/multi-instance.test.ts` |
| 5. worker morto depois do commit e antes do ack | `test/concurrency/crash-before-ack.test.ts` |
| 6. dois publishers na mesma outbox | `test/integration/outbox-publisher.test.ts` |
| 7. ROLLBACK/REFUND antes da referência | `test/integration/pending-references.test.ts`, `test/concurrency/reversal-race.test.ts`, `test/concurrency/restart-consistency.test.ts` |
| 8. reinício com consistência final comprovada | `test/concurrency/restart-consistency.test.ts` |

## 19. Interpretações adotadas

1. **Uma reversão processada por referência, de qualquer tipo.** O desafio diz "não pode ser revertida duas vezes pelo mesmo tipo"; adotamos a forma mais estrita porque `REFUND(BET)` + `ROLLBACK(BET)` creditariam a aposta duas vezes. `ROLLBACK` de um `REFUND` continua permitido (é outra referência).
2. `WIN` pode referenciar uma `BET` (opcional): se a referência ainda não existir, fica `PENDING_REFERENCE`; se a BET já foi revertida, é rejeitado.
3. `LOSS` aceita `amount ≥ 0`; os demais kinds exigem `> 0`.
4. A chave de inbox é o `messageId` do **corpo** da mensagem, não o `MessageId` do SQS, que muda se o produtor reenviar.
5. Wallet inexistente não gera transação persistida (não há wallet a associar): `422 WALLET_NOT_FOUND` no HTTP e DLQ no SQS.
6. `CURRENCY_MISMATCH` e `WALLET_PLAYER_MISMATCH` **são** persistidos como `REJECTED` (auditáveis); por isso `wager_transactions` não tem FK de moeda. `result_currency` guarda a moeda da wallet em que o saldo foi observado.
7. O replay de uma transação que estava `PENDING_REFERENCE` e depois foi resolvida devolve o estado **atual** da linha (a resposta é reconstruída do que está persistido).
8. Eventos de `FAILED` não são publicados: não é rejeição de negócio, e sim um item para a operação (auditável na consulta).
9. Um crédito que levaria o saldo além de 999999999999999999.99 (teto de `numeric(20,2)`) é `REJECTED BALANCE_LIMIT_EXCEEDED` (422, persistido), não `400 INVALID_MONEY`: o payload é válido, quem decide é o estado da wallet.

## 20. Limitações e trade-offs conhecidos

- **Hot wallet é serial por desenho:** a latência cresce linearmente com a contenção numa mesma wallet. Wallets diferentes escalam com o número de instâncias e conexões.
- **Escala monetária fixa** em 2 casas para todas as moedas.
- **Sem tombstone:** um `ROLLBACK` que expira (`REFERENCE_NOT_FOUND`) antes de a `BET` chegar não impede a BET tardia de ser processada.
- **Ordem de eventos não é estrita** entre retries e falhas parciais de lote; os consumidores devem usar `eventId` (dedup) e `walletVersion` (ordem).
- **Takeover lento:** o outbox, depois de um crash, espera o lease (30s); o worker de referências também (30s).
- **Outbox lag sob pico sustentado:** no ambiente local, o lag fica abaixo de 1s até ~400 eventos/s e cresce acima de ~600 eventos/s, onde o MiniStack satura (§21); o evento só atrasa, nunca se perde.
- **Sem retenção de outbox e inbox:** as tabelas crescem linearmente (índices parciais mantêm o claim barato). Um `DELETE` periódico dos publicados há mais de N dias resolveria.
- **Ledger simples:** sem double-entry com contas de contrapartida (house/provider).
- **Erros de trigger com saldo:** as mensagens de erro dos triggers de integridade incluem o saldo; só aparecem em violação de invariante (bug, 500) e então podem chegar ao log.
- **Métricas por réplica:** atrás do nginx, cada scrape cai numa réplica; em produção, o Prometheus descobriria e rasparia cada instância.
- **Sem Postgres no boot, a instância não sobe** (o ORM conecta na inicialização); o compose ordena os serviços por healthcheck. Uma indisponibilidade depois do boot vira `503` e retry.
- **Autenticação** não implementada (§16).

## 21. Teste de carga

`bun run test:load` (`test/load/run.ts`) sobe **3 instâncias reais** (todos os papéis, pool 10, `lock_timeout` 3s) num banco dedicado, com **filas e instâncias novas a cada cenário**, gera carga direto nas instâncias (para raspar o `/metrics` de cada uma), simula um consumidor downstream da fila de eventos e grava o relatório em `test/load/results/` (`.md` + `.json`, fora do git). Cenários: **distributed** (100 wallets) e **hot** (1 wallet); BET de 1.00. Parâmetros: `LOAD_CONCURRENCY`, `LOAD_RATE` (req/s alvo; sem ele, loop fechado puro), `LOAD_DURATION_S`, `LOAD_WARMUP_S`, `LOAD_WALLETS`, `LOAD_INSTANCES`, `LOAD_OUTBOX_INSTANCES` (instâncias só com o papel `outbox`; as demais ficam sem ele), `LOAD_SCENARIOS`. No fim, todas as wallets passam pela reconciliação.

**Ambiente:** notebook i5-12450H (12 threads), 18 GB, Linux 7.0, Bun 1.4.3, PostgreSQL 18.6 e MiniStack em Docker, com gerador e instâncias no mesmo host (que também rodava o desktop; réplicas do compose paradas). 32 usuários virtuais, 20s medidos após 3s de aquecimento. Os números variaram cerca de ±10% entre execuções (o lag no ponto de saturação, mais).

| Cenário | Carga | req/s | p50 | p95 | p99 | Erros | Conflitos de lock | Outbox lag p50 / p99 | Consistente |
|---|---|---|---|---|---|---|---|---|---|
| distributed | 100 req/s | 102 | 6 ms | 9 ms | 13 ms | 0% | 0 | 0,28 s / 0,55 s | sim |
| distributed | 200 req/s | 202 | 7 ms | 12 ms | 18 ms | 0% | 0 | 0,35 s / 0,81 s | sim |
| distributed | 300 req/s | 301 | 9–12 ms | 23–57 ms | 71–102 ms | 0% | 0 | 3–7 s / 8–12 s | sim |
| distributed | sem limite | 506 | 58 ms | 124 ms | 161 ms | 0% | 0 | 18 s / 41 s | sim |
| hot | 100 req/s | 102 | 6 ms | 9 ms | 14 ms | 0% | 0 | 0,28 s / 0,56 s | sim |
| hot | sem limite | 196 | 166 ms | 207 ms | 220 ms | 0% | 0 | 0,43 s / 1,0 s | sim |

**Análise**

- **Correção sob carga:** zero erros, zero 5xx, zero retries e **todas as wallets consistentes** na reconciliação em todas as execuções.
- **Throughput limitado por CPU das instâncias:** sem limite, o distributed chega a ~500 req/s com as 3 instâncias Bun perto de 100% de CPU (event loop single-thread); o Postgres usa ~2 cores. Escalar é adicionar instâncias: não há lock global, e wallets diferentes não disputam nada.
- **Hot wallet é serial por desenho:** o row lock enfileira as transações (até 29 esperando ao mesmo tempo) e a latência é ≈ fila × duração da transação (p50 166ms com 32 usuários). Não houve `LOCK_TIMEOUT` nem conflito de versão: com `FOR UPDATE` cada requisição faz uma única tentativa. É o trade-off escolhido em §6, e o teto (~200 req/s numa wallet) fica muito acima do ritmo de apostas de um jogador.
- **Outbox lag: até ~400 eventos/s fica abaixo de 1s** (cada aposta gera 2 eventos). O piso de ~0,3s vem do ciclo do publisher (`OUTBOX_TICK_MS` 500). Acima de ~600 eventos/s o lag cresce durante a janela e a fila drena depois. Investigação:
  1. A primeira versão esperava o próximo ciclo a cada lote. Corrigido: o publisher drena lotes cheios no mesmo ciclo, envia partições em faixas paralelas (a ordem por wallet se mantém), usa lote de 100 e um **índice parcial `(seq) WHERE published_at IS NULL`** (migration 0006; antes, o claim percorria todo o histórico já publicado). Medido isolado: 672 → 1.159 eventos/s por instância.
  2. **O limite restante é o emulador.** No MiniStack, cada entrada enviada a uma fila FIFO reconstrói o cache de deduplicação inteiro (janela de 5 min; [`_prune_dedup`](https://github.com/ministackorg/ministack/blob/v1.5.30/ministack/services/sqs.py#L1403-L1408), chamado a cada envio), então o envio custa O(mensagens enviadas nos últimos 5 min), independentemente de a fila estar vazia: medido com a fila esvaziada a cada rodada, 2,7ms por lote de 10 após 500 envios e 17ms após 12 mil; numa fila standard, ~1ms constante. Com o processo Python single-thread do MiniStack a 100% de CPU, nenhuma mudança no publisher ajuda. A 300 req/s, **uma instância dedicada ao papel `outbox`** (`LOAD_OUTBOX_INSTANCES=1`) deu o mesmo lag (p99 9s contra 8–12s), com o MiniStack saturado nas duas configurações. A comparação com o LocalStack (§21.1) confirma.
  3. Uma versão anterior do teste rodava o hot depois do distributed na mesma fila, herdando esse cache: o lag do hot parecia 29s e foi atribuído ao grupo FIFO único. Com filas novas por cenário, o hot fica em ~1s no p99 no seu throughput máximo: o grupo único não é o gargalo nessa taxa.
- **O que faria em produção:** SQS real (sem o custo O(n) do emulador) com *high throughput FIFO*, alerta em `outbox_lag_seconds` e, se o publisher passar a disputar CPU com o HTTP, instâncias dedicadas ao papel `outbox` (`ROLES` já permite). Se a ordem por wallet não for necessária para os consumidores, uma fila standard elimina o limite por `MessageGroupId`. A garantia não muda: o evento confirmado nunca se perde e só atrasa.

### 21.1 Comparação com o LocalStack

Para separar o publisher do emulador, a mesma carga rodou contra o **LocalStack 2026.10.1** (auth token pessoal do plano Hobby, container temporário, `SQS_ENDPOINT` apontando para ele; nada disso ficou no repositório):

| | MiniStack 1.5.30 | LocalStack 2026.10.1 |
|---|---|---|
| `SendMessageBatch` FIFO (lote de 10) | 2,7 ms → 17 ms após 12 mil envios | ~2,5 ms, constante |
| outbox lag p99, distributed a 300 req/s | 8–12 s | 0,79 s |
| outbox lag p99, distributed sem limite | 41 s (506 req/s) | 1,39 s (384 req/s) |
| outbox lag p99, hot sem limite | 1,0 s | 0,9 s |

O lag alto do MiniStack é do emulador, não do publisher. O LocalStack usou mais CPU do host compartilhado, daí o throughput HTTP menor sem limite. Mesmo assim, ele **não foi adotado**: além do token, tem um bug de semântica FIFO que afeta o consumidor.

**O bug.** No SQS, `ChangeMessageVisibility` vale a partir da chamada ([AWS: ChangeMessageVisibility](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html)), e a lógica FIFO é por grupo: grupos diferentes são processados em paralelo, e uma mensagem em voo só segura o próprio grupo ([AWS: FIFO queue delivery logic](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)); o consumidor usa isso no backoff de retry transitório e para devolver a mensagem na hora no SIGTERM (§11). No LocalStack, a fila FIFO devolve as mensagens em voo percorrendo **todas** as mensagens em voo da fila em ordem de recebimento e para na primeira ainda invisível, **de qualquer grupo** ([`FifoQueue.requeue_inflight_messages`](https://github.com/localstack/localstack/blob/8b9a79f05846835cf4dff63ab7eefdde9df83783/localstack-core/localstack/services/sqs/models.py#L1166-L1184), último código público; o repositório foi arquivado em 2026-03-23):

```python
for standard_message in messages:
    # in fifo, an invisible message blocks potentially visible messages afterwards
    # this can happen for example if multiple message of the same group are received at once, ...
    if not standard_message.is_visible:
        return
```

O trecho veio do [PR #13386](https://github.com/localstack/localstack/pull/13386) (nov/2025), que corrigiu a [issue #12457](https://github.com/localstack/localstack/issues/12457): a mensagem com visibilidade estendida deve segurar as seguintes **do mesmo grupo**. O comentário e o PR descrevem esse bloqueio por grupo, mas `inflight` guarda as mensagens em voo da fila inteira, então o `return` bloqueia todos os grupos. Não há issue pública para esse efeito (o repositório foi arquivado antes); a evidência é o código acima e a reprodução abaixo. Efeito: o retry (ou a devolução no SIGTERM) de uma wallet espera a visibilidade de qualquer mensagem recebida antes, de outra wallet. Reprodução (A da wallet-a com visibilidade de 20s; B da wallet-b com 2s, como um backoff):

```text
MiniStack 1.5.30                                   LocalStack 2026.10.1
t= 0.0s  A recebida; visibilidade 20s              t= 0.3s  A recebida; visibilidade 20s
t= 0.0s  B recebida; visibilidade 2s               t= 0.3s  B recebida; visibilidade 2s
t= 1.1s  receive -> vazio                          t= 1.3s  receive -> vazio
t= 2.1s  receive -> B (receiveCount=2)             ...      (receive vazio a cada 1s)
                                                   t=21.2s  receive -> A (receiveCount=2), B (receiveCount=2)
```

Log de debug do LocalStack (`LS_LOG=debug`): as duas visibilidades são aceitas às 12:25:19 e as duas mensagens só voltam juntas quando A expira, 21s depois:

```text
12:25:19.252  INFO  AWS sqs.ChangeMessageVisibility => 200
12:25:19.260  INFO  AWS sqs.ChangeMessageVisibility => 200
12:25:40.160  DEBUG re-queueing inflight messages SqsMessage(id=9eb20418-…,group=wallet-a) into queue …trace-….fifo
12:25:40.160  DEBUG re-queueing inflight messages SqsMessage(id=3908eb39-…,group=wallet-b) into queue …trace-….fifo
```

Reproduzido também no 4.14.0, a última imagem sem token. A suíte inteira contra o LocalStack 2026.10.1 passou em 346 de 347 testes; a falha foi justamente `sqs-emulator.test.ts` › *ChangeMessageVisibility delays redelivery*. A correção não seria afetada (o retry só atrasa, e a contagem para a DLQ continua certa), mas o backoff deixaria de ser o configurado.

**Fontes:** [AWS: ChangeMessageVisibility](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html) · [AWS: FIFO queue delivery logic](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html) · [LocalStack PR #13386](https://github.com/localstack/localstack/pull/13386) e [issue #12457](https://github.com/localstack/localstack/issues/12457) · [LocalStack — mudança para imagem única com auth token](https://blog.localstack.cloud/localstack-single-image-next-steps/) · [LocalStack 2026.03.0](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/) · [preços e termos do plano Hobby](https://www.localstack.cloud/pricing) · [SQS no LocalStack (disponível a partir do Hobby)](https://docs.localstack.cloud/aws/services/sqs/) · [LocalStack — AWS deep dives: SQS](https://blog.localstack.cloud/aws-deep-dives-sqs/).
