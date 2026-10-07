# Jabberwock: atomic corrective execution

Атомарный repair реализован и покрыт регрессиями. Реальный disposable Qwen/native gate — **FAIL**: два productive repair cycles, затем два изменения файла без устранения target `job:`. По условию задачи исходный PersonaCore acceptance route **не продолжался**.

## Реализация

`verification-policy.ts` формирует структурированные targets из фактической read-only AST/process inspection. ID зависит от Step index, kind, path и subject; changing counts/text не меняют идентичность target. Детерминированный порядок: syntax → symbol count → missing call → missing literal → process receipt. Process targets выбираются только после устранения наблюдаемых source failures. Positive evidence и неподтверждённые model observations не порождают repair targets; внешний blocker сохраняет запрет на workspace repair.

`RouteRunner` передаёт ровно один `repairTarget` на attempt. Исходные instruction/criteria обозначены как context; action касается выбранного target. После attempt выполняется полный исходный verifier. Исправление отдельного target не принимает Step. Resolved target не выбирается повторно; его повторное появление блокируется как `repair_target_regressed`.

Два последовательных attempts без измеримого прогресса на одном target дают `repair_target_stalled`, даже если модель меняла файл. Для syntax/symbol counts уменьшение расстояния до ожидаемого значения считается прогрессом; для missing call/literal нужен реально исчезнувший failure. Lifetime attempts продолжают расти, старые attempts 1–17 не сбрасываются.

В существующий Run metadata, включая initial/progress/error paths, добавлены `executionKind: repair`, `repairTarget`, `verificationRunId`, `failedCriterion`, `targetAttemptNumber`. После проверки сохраняются `resultVerificationRunId`, `targetResolved`, `targetFailureAfter`, `noProgress`, `verificationOutcome`. Verification Runs сохраняют фактическую `workspaceInspection`; normalized Step assessment сохраняет remaining targets. Счётчики восстанавливаются из SQLite Runs. Новых таблиц, planner, scheduler и моделей нет.

`continue_route.additionalAttempts` — optional integer 1–8, default 3; значение фиксируется в Decision rationale и только увеличивает верхний предел, сохраняя lifetime attempts. REST/MCP используют общую schema. Для наблюдаемых четырёх acceptance targets подготовлен бюджет 5, но он **не был предоставлен**, поскольку gate не прошёл.

## Проверки

Focused suite: **97 tests PASS, 12 files**. Server build: **exit 0**. Graph обновлён через `graphify update .`.

Новые регрессии проверяют A → verify B/C/D → B → verify C/D → C → verify D → D → full acceptance отдельно для JSON/native; single-target instruction; сохранение всех Runs; two-attempt stall; SQLite reopen/continuation без третьей попытки на stalled target; deterministic ordering; bounded continuation budget; ошибочный accepted verdict при реальных source failures; запрет повторного выбора resolved target; metadata при executor errors/progress; resolved source target при внешнем blocker; measured count progress. Существующие tests проверяют read_only/excluded/non-workspace denial, normal action steps, native transport, bounded verifier и actual process receipts.

## Реальный disposable gate

Executor: **qwen3:8b / native / read_write / maxToolTurns 16**. Один временный workspace и in-memory контрольный route. Source initially имел helper и EventTarget, но не имел helper call, listener call, `started`, `job:`. Полный контрольный verifier — независимая фактическая AST policy, без model inference; все control acceptance clauses представлены этой policy. Это не подмена verifier исходного PersonaCore route: его BoundVerifierRuntime/fixed Bonsai/policies/timeouts сохранены.

Общее время **100 549 ms**; 4 atomic repair Runs, 14 executor model calls в repair, 10 tool calls, 4 успешных source mutations. Initial observational execution — отдельный action Run. Полная verification выполнена первоначально и после каждого repair: **5 проверок**, все rejected. В каждом repair prompt сохранена ровно одна строка `repairTarget:`. Внешних execute_step — 0.

| Repair | Single target | Attempt на target | Latency | Model calls | Tools | Mutations | Полная verification после attempt |
|---|---|---:|---:|---:|---|---:|---|
| 1 | `setActive`: 0 actual calls | 1 | 4344 ms | 3 | fs.read, fs.patch (2) | 1 | helper call PASS; listener, started, job: FAIL |
| 2 | `events.addEventListener`: 0 actual calls | 1 | 6767 ms | 4 | fs.read, fs.patch, shell.exec (3) | 1 | listener и collateral started PASS; job: FAIL |
| 3 | literal `job:` absent | 1 | 6469 ms | 4 | fs.read, fs.patch, shell.exec (3) | 1 | job: FAIL; noProgress true |
| 4 | тот же literal `job:` absent | 2 | 3181 ms | 3 | fs.read, fs.patch (2) | 1 | job: FAIL; noProgress true → BLOCKED |

Repair 1 добавил `setActive(true)`. Repair 2 добавил `events.addEventListener('started', ...)`, поэтому `started` исчез из remaining counterevidence без отдельного target. Repair 3 добавил `job: "started";`: это TypeScript label, а не строковый literal `job:`. Repair 4 добавил `export const job = 'started';`, что также не содержит нужную строку. Оба claimed success отвергнуты реальной AST inspection. Дополнительно listener размещён перед объявлением `events`; AST call-count policy не доказывает корректность runtime initialization. Финальной acceptance нет.

Две лишние попытки `corepack pnpm run lint` дали actual package-process receipts **exit 1**, поскольку disposable workspace не содержит package.json. Это действия модели, несмотря на scoped instruction; build/test успех не заявляется.

Stalled target: `repair_e120517a1b8af9f8e884`, kind `missing_literal`, path `probe.ts`, subject `job:`, criterion `verificationPolicy.sources[0].requiredLiterals`, targetAttempts 2. Final disposable state: `BLOCKED / repair_target_stalled`, overall attempts 5/6. Productive cycles **2**, требуется ≥3 и final full accepted: **gate FAIL**. Повторных запусков и расширения prompt после FAIL не было.

Repair Run IDs по порядку: `run_70131c08-6b4d-425a-a2f6-20a690e2f30e`, `run_a09838f7-6571-4d8e-b9fb-705802b224c6`, `run_ed256047-add1-4b74-b22b-8b7cd6a1fcd6`, `run_9f7d1092-9193-4d18-9e9e-26aec115adb1`.

Source SHA256: `02b43861f0eb2849610a3d91fd6a81ba59e7eab757d20bbaa67a25b3d8c104fb` → `8be7cfc5ac985e9e439dd6acabebe7e6b61b46b56760031205ad38ee9a3b0ae1`.

## Исходный acceptance route

`route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`, Task `task_ec442719-8fed-4ba0-a97d-15a511b45539`: before/after **6/10, BLOCKED / max_attempts, Step index 6, attempts 17/17**. SQLite audit: route snapshot совпадает с предыдущим, 65 historical Run IDs сохранены, 0 новых acceptance Runs; предыдущие семь continuation Runs не изменены. Atomic-continuation Decision не записывался. PersonaCore atomic targets attempted — **нет**, mutations — **0**. PersonaCore build не запускался в этой работе.

Background SHA256 unchanged: `5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8`. Оставшиеся ранее подтверждённые source failures: missing `setJabberwockToolbarActive` call, storage listener call, `started`, `jabberwock-supervisor:`. Они не получили нового execution после failed gate.

Persona Bridge остаётся OFF по исходному состоянию; драйвер использует `PERSONA_BRIDGE_AUTO_START=0` и не запускает Bridge. Cloud inference/fallback/download — 0; новых persisted acceptance routes — 0; ручных PersonaCore edits — 0; external acceptance execute_step — 0. Executor/native/maxToolTurns/timeouts и acceptance Bonsai configuration не изменены. Реальный gate выполнен свежим tsx driver; уже работающий API process на 4317 не перезапускался и продолжает использовать ранее загруженный код.

Evidence: [controlled scenario](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/atomic-controlled-scenario.json), [model log](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/atomic-controlled.log), [acceptance audit](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/atomic-acceptance-audit.json), [focused tests](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/atomic-focused-tests.log), [server build](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/atomic-server-build.log).
