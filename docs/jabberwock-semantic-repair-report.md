# Semantic repair-target contract

Контракт реализован. Bare `missing_literal` больше не запускает mutation. Добавлены argument-aware calls, callback scope и явный module-level scope. **Окончательный реальный gate — FAIL**: source review выявил unused wrapper вместо требуемой initialization. PersonaCore не продолжался.

Каждый новый policy-produced target содержит `id`, `kind`, `path`, `subject`, `criterionReference`, `expectedCondition`, `actualEvidence`, `repairability`, при необходимости `semanticAnchor` и `supportingFailures`. `expectedCondition` задаёт разрешающий predicate; `actualEvidence` содержит source SHA256, observed/eligible counts и AST observations. Historical metadata читается без миграции: новые поля optional в reader schema, но selector требует explicit auto repairability, condition и actual evidence.

Auto-repairable: syntax diagnostics, unique function/arrow declaration count, actual call count, semantic call predicates и actual package-process receipt. Source targets идут раньше process targets. Calls поддерживают `minCount`, аргументы `equals` для string/number/boolean/null, `stringContains` для непосредственного строкового argument или статического fragment используемого template. Все constraints должны выполняться на одном call. `within` ограничивает helper вызовы телом конкретного listener callback, с собственными constraints на arguments регистрации. Поддержаны inline callbacks и однозначно определённые top-level named callbacks. Неиспользуемые вложенные функции не учитываются как calls самого callback.

`topLevel: true` требует module-level call вне functions/classes. Это минимальная lexical scope проверка, а не compiler/dataflow или доказательство runtime execution. Условия вроде reachability всех branches, symbol resolution через imports/aliases и произвольные computed values не доказываются. Build/test steps по-прежнему необходимы там, где их требует route.

Пример additive policy; существующие string `requiredCalls` сохраняются:

```json
{
  "path": "source.ts",
  "requiredCalls": [
    "legacyHelper",
    {
      "callee": "setActive",
      "arguments": [{ "index": 0, "equals": true }],
      "within": {
        "callee": "events.addEventListener",
        "callbackArgument": 1,
        "arguments": [{ "index": 0, "equals": "started" }]
      }
    },
    {
      "callee": "storage.set",
      "arguments": [
        { "index": 0, "stringContains": "job:" },
        { "index": 1, "equals": "started" }
      ]
    }
  ]
}
```

Один object predicate даёт **один primary repairTarget**. Невыполненные argument constraints сохраняются как `supportingFailures` этого target: например prefix и state относятся к тому же `storage.set`, а не превращаются в две отдельные просьбы вставить tokens. Добавленная в другом месте `const marker = 'job:'` не удовлетворяет bound argument predicate. ID semantic target включает его resolution condition, поэтому отсутствие call и появление call с неправильными arguments остаются тем же target. Resolved/stalled accounting, JSON/native parity, permission guards и full verification после каждого repair сохранены.

Legacy `requiredLiterals` остаются полными verifier counterevidence/presence proxies. Их targets имеют `repairability: evidence_only`; selector не запускает отдельный literal repair и не пропускает process work за unresolved source evidence. Если остаются только такие failures, route блокируется как `repair_scope_unknown`. Не угадываются связи literals с listener/storage; semantic association должна быть задана исходной policy. Prompt явно запрещает dead/unrelated code, dummy constants и isolated literal insertion, связывает изменение с original criterion и объясняет роль supporting failures. Verifier принимает только весь исходный Step, а не отдельную mutation.

Проверки: **107 tests PASS / 13 focused files**, server build **exit 0**. Новые regressions: missing call contract; wrong arguments; callback ownership; missing listener; bare literal exclusion и block после semantic repairs; grouped supporting failures; dead constants; same-call constraints; template prefix; named callbacks/unused nested functions; module initialization/unused wrapper; strict schema compatibility; JSON/native sequence; structured metadata в SQLite reopen. Существующие tests сохраняют bounded stall/recovery, read_only/external denial, resolved-target regression, native transport, bounded verifier и process receipts.

Реальный disposable scenario использовал **qwen3:8b / native / read_write / maxToolTurns 16**, прежний timeout и repair budget 6. Control verifier выполнял полную независимую AST inspection всех control clauses; inference verifier модель исходного acceptance route не менялась. Workspace package-less; build/test для его source acceptance не требуется. Добавлен отдельный final source-verification Step; acceptance всего control route не следует из одной mutation. Control route in-memory, без нового persisted acceptance route.

| Repair | Target / фактическая mutation | Latency | Model calls | Tools | Mutations | Full source verdict |
|---|---|---:|---:|---:|---:|---|
| A | `call.ts`: missing `setActive(true)`; модель добавила exported `ensureActive()` с таким call | 9548 ms | 5 | 4 | 1 | Первоначальный call-count predicate PASS; B/C остаются. **Initialization не установлена** |
| B | `event.ts`: argument `wrong-event` → `started` у существующей регистрации `onStarted` | 8207 ms | 4 | 3 | 1 | B PASS; C остаётся |
| C | `callback.ts`: `setActive(false)` → `setActive(true)` внутри существующего started callback | 4487 ms | 4 | 3 | 1 | Первоначальная AST policy accepted |

Всего **115 859 ms**, 3 actual repair mutations, 13 repair model calls, 10 repair tools. Каждый Run содержит ровно один primary target; полного task replay не было. Raw candidate artifact сохранил 3 resolved targets и COMPLETED 2/2: первоначальная AST policy принимала `setActive(true)` в любой function. Были четыре полные проверки first Step и отдельная full final source verification.

При обязательном просмотре actual diff обнаружено, что A не реализует исходный criterion «initializes active»: новая `ensureActive()` нигде не вызывается. Это недостаточный resolution contract. **Raw candidate PASS не использован как разрешение продолжить PersonaCore.** Добавлен regression и явный `topLevel` predicate, затем выполнена только read-only повторная inspection сохранённого source, без второго Qwen запуска и без ручного изменения disposable source. Она даёт:

```json
{
  "type": "call_count",
  "callee": "setActive",
  "min": 1,
  "arguments": [{ "index": 0, "equals": true }],
  "topLevel": true
}
```

Actual eligible count **0**, target `call.ts / setActive / module initialization` unresolved. Строгих productive cycles **2**, требуется ≥3 и full original criterion accepted: **final gate FAIL**. Первоначальные Runs/source/artifact не переписаны; review FAIL сохранён отдельно. Continue driver требует и raw gate, и criterion review PASS. После FAIL model reruns — 0; PersonaCore continuation — 0. Два package-less `corepack pnpm run typecheck`, запрошенные моделью, дали actual receipts exit 1 (`NO_IMPORTER_MANIFEST_FOUND`); typecheck/build успех не заявляется.

Изменения source при A не являются literal-only фиксом, но unused wrapper нельзя считать требуемой initialization. Это конкретный remaining blocker controlled gate. Новый module-level contract готов для будущего запуска; текущая работа остановила реальные model attempts согласно условию FAIL → STOP.

Исходный route `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`, Task `task_ec442719-8fed-4ba0-a97d-15a511b45539`: before/after **6/10, BLOCKED / max_attempts, Step 6, attempts 17/17**. Audit snapshot: route, **все 65 Runs целиком**, Decisions и background SHA256 unchanged; новых acceptance Runs — 0. Approval Decision после gate не записывался, дополнительный budget не предоставлялся. PersonaCore targets attempted — **нет**; actual mutations — **0**; build/test steps не достигнуты и не запускались.

Существующая acceptance policy не изменена: missing helper/listener calls могли бы стать semantic targets; unanchored `started` и `jabberwock-supervisor:` остаются evidence-only, пока source policy не задаёт связь. Связь не hardcoded в Runner и не выводится из имени PersonaCore. Полный Bonsai verifier, model/native routing, attempts/history, turn/timeout limits сохранены. Persona Bridge OFF, `PERSONA_BRIDGE_AUTO_START=0`; cloud fallback/download — 0; manual PersonaCore edits — 0; external execute_step — 0; новых persisted acceptance routes — 0. Реальная проверка выполнялась свежим tsx driver; API process на 4317 не перезапускался.

Evidence: [raw control](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/semantic-contract-first-gate-2026-10-02/semantic-controlled-scenario.json), [authoritative criterion review](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/semantic-contract-first-gate-2026-10-02/semantic-controlled-review.json), [model log](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/semantic-contract-first-gate-2026-10-02/semantic-controlled.log), [acceptance audit](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/semantic-contract-first-gate-2026-10-02/semantic-acceptance-audit.json), [tests](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/semantic-contract-first-gate-2026-10-02/semantic-focused-tests.log), [build](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/semantic-contract-first-gate-2026-10-02/semantic-server-build.log). AST graph обновлён через `graphify update .`, без LLM/API.
