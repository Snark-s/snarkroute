# Jabberwock: bounded verification и продолжение acceptance

Дата: 1 октября 2026. Итог: **BLOCKED / max_attempts**, исходный route сохранён. PersonaCore activity indicator пока не готов, build не выполнен. Это новый обоснованный BLOCKED после исправления инфраструктуры и автономных corrective attempts.

## Причина прежних 600 секунд

Verifier использовал тот же `SnarkRouteAtomicAgentRuntime`, что и coding executor: до 16 model turns, история всей Task и прошлых проверок, повторные чтения background/dispatcher/tests. Generation не имела отдельного лимита. Ниже — сохранённые метрики трёх исходных verification Runs; суммарное время относится к успешно завершившимся local model HTTP calls.

| Run | Время Run, мс | Model calls / tools | Завершённых calls | Сумма их времени, мс | Максимум prompt, символов | Максимум completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `run_3377d1ee-5d04-4efe-aec4-650745c9b636` | 600013 | 12 / 58 | 11 | 580994 | 32187 | 3986 |
| `run_baac6a00-8017-4c43-8e02-85a4b620e403` | 599998 | 16 / 59 | 15 | 554907 | 32308 | 2380 |
| `run_c1805441-a87d-402e-a780-901600eb7fb8` | 599998 | 11 / 51 | 10 | 532026 | 32488 | 3633 |

89–97% общего времени уже объяснены последовательными завершёнными обращениями к модели. Последний незавершённый call прерывался общим timeout. В логах очередь 0, concurrency 1; успешные calls действительно завершали HTTP response и возвращали usage. Evidence не подтверждает один зависший 600-секундный ответ после завершения generation. Метрики не разделяют prefill и decode, поэтому точное распределение между ними не доказано. Детали: `apps/server/data/jabberwock/verification-timeout-diagnosis.json`.

## Изменения

Production verifier выделен в `BoundedVerifierRuntime`, использующий существующие Supervisor/router/text/provider gate. Coding runtime и scheduler не переписаны. Verifier читает текущие критерии, максимум 4000 символов последнего execution evidence и короткие результаты inspection; полная Task history не передаётся в его model prompt. Бюджеты: 3 model calls, 6 read/search/diff tools, 120 строк одного read, 1200 символов результата; 768 output tokens, temperature 0, отдельный timeout 90 секунд (явный максимум 180 секунд). Verdict содержит `accepted|rejected|unknown`, reason, evidence, counterevidence. Contradictory accepted превращается в rejected. Timeout/unknown/malformed exhaustion блокируют route, не принимают step и не запускают новый coding loop автоматически.

Verifier всегда использует read-only tools. Source policies читают файл с ограничением 1 MB и считают AST declarations/call sites: комментарии, строки и imports не считаются вызовами. Required process policies принимают только реальные успешные package-process receipts: command, exitCode, durationMs, stdoutSummary, stderrSummary. Наличие package.json script и слова модели не подходят. Interrupted writes по-прежнему сверяются по сохранённым SHA256, без replay. Concrete counterevidence вызывает incremental corrective execution текущего step в пределах его attempts; старые completed Steps/history не стираются.

`verificationConfig` хранится в дополнительной SQLite column, отдельно от executor config. Его optional executionConfig влияет только на routing/model/constraints verifier. Автоматического fallback нет. State показывает обе конфигурации и последние verification Run/model/runtime/verdict/duration. Legacy standalone execute_step/default/fixed routing сохранены.

Во время продолжения выяснилось, что executor выдавал невалидный JSON, включая 5955-token ответ за 166977 мс. Добавлены separate executor generation cap 2048 и JSON response mode. Local adapter теперь передаёт response_format backend; поддержка JSON-режима описана в [официальной документации llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). Live `/slots` подтвердил maxTokens 2048 и temperature 0. Последняя попытка всё равно не сделала edits: 10 model calls, 43 tools, затем provider error `returned neither text nor tool_calls`. Точная причина пустого итогового payload из имеющихся метрик не установлена; это не доказательство универсальной непригодности Bonsai.

## Реальное продолжение

| Параметр | Результат |
| --- | --- |
| Route | `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09` |
| Task | `task_ec442719-8fed-4ba0-a97d-15a511b45539` |
| PersonaCore | `I:/PersonaCore/extension` |
| continue_route | 1 вызов, исходный ID; нового route нет |
| Progress до / после | 6/10 → 6/10 |
| Текущий step | index 6, Verify completion and error |
| Lifetime attempts текущего step | 2 → 5; 3 дополнительные попытки |
| Route retries | 3 → 6; +3 в этом продолжении |
| Executor model | fixed `bonsai-2-27b`, тот же local 27B Ternary PQ2 GGUF, 127.0.0.1:8080 |
| Verifier model | configured fixed Bonsai; фактические отказы — deterministic AST, **0 inference calls** |
| Новые verification Runs | 4 rejected; 78, 41, 83, 44 мс — время Run, отдельно от предварительного source probe |
| Execution attempts | 600004 мс timeout; 93781 мс interrupted при infrastructure reload; 342661 мс provider empty-output error |
| Дополнительные перезапуски | 1 acceptance Supervisor reload, затем основной API reload; completed progress/attempts не сбрасывались |
| Final status | BLOCKED / max_attempts, попытки исчерпаны |
| Build/test PersonaCore | Не запускались: package-process receipts отсутствуют, следующие steps pending |
| PersonaCore edits в этом продолжении | **Ни одного**: mutation journal пуст, background SHA256 не изменился |
| Внешние execute_step / ручные PersonaCore edits | 0 / 0 |
| Active Runs после завершения | 0 |

Независимая проверка: `setJabberwockToolbarActive` имеет одну реализацию и **0 call sites**; `chrome.storage.onChanged.addListener` в background — **0**; отсутствуют `started` и `jabberwock-supervisor:` в toolbar wiring. Background SHA256 остался `5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8`. Существующий dispatcher переводит request started → completed как при успешном ответе, так и при catch error, но toolbar к нему не подключён. Initial state / success / error / overlap для toolbar не доказаны и не засчитаны. Имеющийся interval — badge animation, нового request polling или второй state machine не добавлено. Старый ошибочный accepted toolbar Step сохранён как история; текущая corrective verification предотвращает ложный COMPLETED.

Нового PersonaCore diff нет. Activity files в этом checkout untracked, поэтому пустой tracked `git diff --stat` не считается доказательством отсутствия изменений: использованы actual source AST, SHA256 и mutation journal. Весь существующий diff и старые изменения не приписываются этому продолжению. Lifecycle automated test не добавлен: executor до этого не дошёл.

## Основной API и Working Memory

Основной API на 4317 был на старой версии. Перед прямым reload проверены отсутствие Persona jobs и завершённая H3 session. Launcher не перезапускался, `PERSONA_BRIDGE_AUTO_START=0` передан новому API process. API health и Route Runner capabilities после reload успешны.

Дополнительно выявлен прежний hardcoded путь acceptance driver, отличавшийся от `JABBERWOCK_MEMORY_PATH` в `.env`. Driver теперь соблюдает настройку. Только acceptance Task и связанная история атомарно добавлены в настроенную базу `Y:/Процесс/SnarkRoute/data/jabberwock/working-memory.sqlite`: 1 project, 1 Task, 1 route, 10 Steps, 40 Runs, 7 Facts, 1 Decision, с исходными IDs. Source database сохранена. Target snapshot перед импортом: `apps/server/data/jabberwock/native-before-acceptance-import.sqlite`. Все исходные target rows проверены на точное сохранение: 2 Projects, 7 Tasks, 186 Steps, 183 Runs. Формат хранения/ORP/IDs не менялся, существующие записи не перезаписывались. Повторный импорт того же Task запрещён; schema mismatch откатывает transaction. Native GET теперь возвращает исходный BLOCKED route, progress 6/10 и verifier metadata. Снимок: `apps/server/data/jabberwock/bounded-continuation-native-api-state.json`.

Persona Bridge switch расширения не трогался; его OFF — исходное состояние, указанное пользователем. Никакого browser/ChatGPT UI automation не было. При диагностике обнаружен уже работающий local companion service на 8766; состояние listener не доказывает, включён ли клиент расширения. Полное OFF всех companion процессов в течение всей задачи независимо не подтверждено и не заявляется.

## Проверки и файлы

- Server build: `corepack pnpm --filter @snarkroute/server build` — exit 0.
- Профильные suites с local adapter: 77 tests / 14 files, passed.
- Server: 362 tests / 62 files, passed, `--maxWorkers=2 --minWorkers=1 --testTimeout=15000`.
- После последнего усиления receipt guard: 16 tests / 3 touched suites, passed.
- Explicit route import test: 1 passed, проверены additive copy, сохранение history/attempts, duplicate refusal и transaction rollback.
- Первые общие прогоны имели 5-секундные import/API timeouts. AST parser сделан lazy; каталог/API checks повторены с достаточным integration timeout, без изменения assertions. Финальный общий прогон зелёный.
- Model-catalog Gemini icon failure не исправлялся; полный root suite в этом продолжении не запускался.
- Graphify обновлён AST-only: 0 API/LLM cost. Предупреждение о отсутствующем tree_sitter_sql остаётся.

Изменённые SnarkRoute файлы:

- `apps/server/src/jabberwock-memory/bounded-verifier.ts`, `verification-policy.ts`: отдельный verifier и actual source/process gates.
- `apps/server/src/jabberwock-memory/route-runner.ts`, `route-input.ts`, `route-types.ts`, `storage.ts`: конфигурация, persistence, bounded unknown semantics, corrective retry, model/runtime state.
- `apps/server/src/jabberwock-memory/supervisor-bridge.ts`, `atomic-agent-runtime.ts`, `atomic-tools.ts`: разделение runtimes, generation configuration, read-only source inspection, real command receipts.
- `apps/server/src/providers/local-openai.ts`: forwarding response_format, provider/routing не менялись.
- Tests: memory `bounded-verifier`, `route-verification`, `atomic-tools`, `atomic-agent-runtime`; server `local-openai`.
- `scripts/jabberwock-script-worker.mjs`: stdout/stderr/duration receipts.
- `scripts/jabberwock-route-acceptance.ts`: continue existing route, actual call/event/build policies, configured memory path.
- `scripts/jabberwock-route-import.mjs`, `.test.mjs`: явный атомарный перенос acceptance history без overwrite.
- `docs/jabberwock-route-runner.md`, этот report: актуальное поведение и evidence.

Ограничения: реальный toolbar пока не подключён и PersonaCore build не выполнен. Исполнитель в данном прогоне не справился даже после исправления JSON/generation configuration. Model path в state может быть физическим GGUF; logical ID остаётся Bonsai. Четыре реальных verifier отказы были deterministic и не измеряют скорость модельного accepted verdict; модельные accepted/rejected/unknown проверены профильными tests. Для продолжения нужен явный выбор executor configuration/model, без платного/cloud fallback. Текущая цель не достигла COMPLETED.

Единственный необходимый внешний вопрос: **какую другую локальную модель явно выбрать для executor этого же маршрута вместо `bonsai-2-27b`?**
