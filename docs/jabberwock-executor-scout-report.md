Controlled Executor Scout, 2026-10-02. Выбран `bonsai-2-27b / native`: единственный strict PASS. Затем SAME PersonaCore route был продолжен и остановился на первом atomic target без мутаций. Итог acceptance: **BLOCKED, 6/10**, `repair_target_stalled`.

Authoritative gateVersion: `semantic-atomic-v2-b00d87e5f3957df3`.
Raw trialVersion: `semantic-atomic-v1-9acfc9cfb69ed2ea`.
Результаты старого AST-only PASS были заново проверены read-only authoritative review; они не автоматически эквивалентны strict PASS. Версия review учитывает контракт сохранения существующей реализации и hash реализации Scout. Новые запуски дополнительно включают hashes semantic verifier / repair-target / Runner / Atomic runtime.

| model | protocol | Level 1 | Level 2 | gate latency | mutations | productive repairs L1 / L2 | failure reason |
|---|---|---|---|---:|---:|---:|---|
| qwen3:8b | native | PASS | FAIL | 18.380 s | 2 | 1 / 0 | L2: recursive call внутри `setActive`; eligible module-level count = 0; два no-progress attempts |
| llama3:latest | JSON | FAIL | skipped | 61.033 s | 0 | 0 / 0 | Повторные чтения; неудачный patch: old text must occur exactly once; target остался открытым |
| gemma3:12b | JSON | FAIL | skipped | 121.453 s | 5 | 0 / 0 | Перезаписала исходник; `setActive` implementation count = 0, eligible call count = 0; лимит двух L1 attempts |
| gemma3:27b | JSON | FAIL (review) | не допущена; преждевременная проба остановлена | 184.994 s | 1 | 0 / 0 | Удалила `active`, оставила пустую реализацию helper; формальный AST PASS отклонён |
| bonsai-2-27b | native | PASS | PASS | 154.527 s | 4 | 1 / 3 | none |

Latency, mutations и calls в таблицах относятся к завершённым semantic trials L1 + L2. Native protocol smoke учитывается отдельно: Qwen 53.365 s, Bonsai 53.963 s. Со smoke полное измеренное время этих кандидатов — 71.745 s и 208.490 s. Прерванная невалидная L2 Gemma 27B исключена из сравнительной таблицы; её затраты указаны ниже. Cold loading включён в wall time. Qwen прогрет protocol smoke, Bonsai уже resident; JSON-кандидаты начинали cold. Эти времена не являются сравнением чистой скорости inference. На выбор это не повлияло: full PASS ровно один.

| model | model calls | tool calls | no-progress | malformed outputs | provider errors | verifier rejects | peak prompt tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| qwen3:8b | 11 | 8 | 2 | 0 | 0 | 4 | 1903 |
| llama3:latest | 11 | 13 | 2 | 0 | 0 | 3 | 2339 |
| gemma3:12b | 10 | 12 | 2 | 0 | 0 | 3 | 2912 |
| gemma3:27b | 2 | 1 | 0 | 0 | 0 | 1 | 1821 |
| bonsai-2-27b | 17 | 21 | 0 | 0 | 0 | 4 | 2509 |

Qwen самостоятельно запросил `pnpm run test` в package-less fixture: exit 1, `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`. Gemma 12B дважды запросила `git.diff` вне Git repository: exit 1. Bonsai не запрашивал process/build calls в gate. Raw receipts сохранены отдельно от оценки coding capability.

Все кандидаты используют существующий SnarkRoute local OpenAI-compatible provider, без fallback. Ollama endpoint `http://127.0.0.1:11434/v1`; Bonsai endpoint `http://127.0.0.1:8080/v1`. Фактический Bonsai provider model: `I:\AI\Bonsai-demo\models\bonsai2-gguf\27B\Ternary-Bonsai-2-27B-PQ2_0.gguf`.

| model | context, discovered | GGUF bytes | actual protocol compatibility |
|---|---:|---:|---|
| qwen3:8b | architecture max 40960 | 5225388164 | real native read/patch/reread smoke PASS |
| llama3:latest | architecture max 8192 | 4661224676 | Atomic JSON turns/tools worked; native not advertised |
| gemma3:12b | architecture max 131072 | 8149190253 | Atomic JSON mutations worked; native not advertised |
| gemma3:27b | architecture max 131072 | 17396936941 | Atomic JSON mutation worked; native not advertised |
| bonsai-2-27b | configured slot 32768 | 7206168928 | real native read/patch/reread smoke PASS |

Observed Ollama residency для обеих Gemma: configured `context_length = 8192`; это отличается от architecture maximum. Для Qwen/Llama post-load residency не снималась; их actual prompt usage сохранён. Все четыре Ollama-кандидата первоначально cold. Bonsai initially warm. Gemma 27B observed `size_vram = 14354544066`, Gemma 12B `8346256015`; disk size не выдаётся за измеренный GPU footprint.

Gemma IDs добавлены только в process-local allowlist существующего Ollama endpoint. `.env`, server-facing catalog routes и endpoints не изменены. Исключены установленная LLaVA (vision-focused, вне выбранного coding scope) и DeepSeek cloud. Downloads, cloud requests, KIE, RuTronix, новый acceptance route и отдельная DB не использовались.

Одинаковый gate: исходные `call.ts`, `event.ts`, `callback.ts`; неизменные policies с `topLevel:true`, правильным event argument и helper argument внутри started callback. Начало — реальный verify, затем один assigned repair, полный AST verify после каждого repair. L1 maxAttempts = 2; L2 maxAttempts = 6 и существующий per-target bounded stall. Общий Atomic coding prompt не менялся для отдельных моделей. Generation cap 2048, temperature 0, maxToolTurns 16. Executor timeout не увеличивался; verifier timeout 90000 ms.

Для disposable fixture использовался существующий полный AST source verifier, без model inference в control verifier. Authoritative review отдельно прочитал реальные итоговые файлы, отверг рекурсию, пустые/заменённые реализации, лишние registrations, заменённый callback и mutation вне assigned target. Build/runtime correctness этим gate не заявляется. Actual model inference, tools, source mutations и Runner были реальными.

Bonsai выполнил последовательно:

1. Добавил `setActive(true)` на уровне модуля, сохранив исходные state/helper.
2. Заменил `"wrong-event"` на `"started"` в существующей registration `onStarted`.
3. Заменил `setActive(false)` на `setActive(true)` в существующем started callback.

Три distinct targets resolved; full final AST inspection accepted; authoritative review accepted; no-progress = 0. Selector допускает только same-version L1 + L2 + final review PASS и ≥3 productive L2 repairs. Порядок сравнения: failed/no-progress attempts, semantic gate wall time, model/tool calls, footprint, stable model ID; protocol не участвует в ranking. Здесь сравнение между несколькими PASS не понадобилось.

Во время bake-off выявлен дефект harness review: Gemma 27B прошла формальные AST counts с пустым helper. L2 ошибочно стартовала до проверки сохранения реализации. Собственный Scout driver был остановлен; acceptance state тогда оставался byte-equivalent, без новых Runs/Decisions. Raw L1 PASS не переписан; authoritative результат — FAIL. По сохранённому partial log этой невалидной L2: 22 started model calls, 21 completed tool calls, 287037 ms суммарных завершённых model-call durations. Полный in-memory Run journal после остановки недоступен; сохранены log и actual source snapshot. Этот partial trial не считается результатом допустимого Level 2. Все уже законченные trials сохранены и не перезапускались. Добавлены regression tests на empty-helper false PASS. Исправлен и протестирован selector, который первоначально ошибочно считал дополнительные structured metrics нечисловыми ranking fields.

PersonaCore continuation выполнен только после authoritative PASS, на том же route `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`.

Decision `decision_52be5522-a65a-4863-8a16-a4efe9fb3ac4`:

> User approved continuing the same route with the local executor that passed semantic repair gate semantic-atomic-v2-b00d87e5f3957df3.

Executor: fixed Bonsai / native / agent / read_write / 16 turns. Verifier: существующий BoundedVerifierRuntime, fixed Bonsai, 90000 ms; model config и timeout сохранены. Остальные policies и step acceptance criteria сохранены.

Изменён только source policy Step 6: session initialization требует `chrome.storage.session.get(null)`; prefix `key.startsWith('jabberwock-supervisor:')` и точная state equality `Object.is(..., 'started')` привязаны к callback `Object.entries(values).some`. Это конкретная форма исходного lifecycle behavior в рамках поддерживаемого CallPredicate; standalone background literal targets удалены. Dispatcher source probe сохранён. Runner semantics и PersonaCore source вручную не менялись. До continuation prepared read-only inspection показал пять auto-repairable targets; выданы шесть дополнительных attempts. Lifetime attempts не сброшены.

Итог реального PersonaCore diagnostic case:

- Step 6 `step_1da09415-6ff4-4a6e-85a3-069c1f2f69ec`, `Verify completion and error`.
- Target `repair_fc8d42e55e12cb04b8d0`, `src/background/index.ts`, missing call `setJabberwockToolbarActive`.
- expectedCondition: `{ "type": "call_count", "callee": "setJabberwockToolbarActive", "min": 1 }`.
- actualEvidence: observedCount 0, totalCount 0; source hash `5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8`.
- Target attempt 1: Run `run_8d2eb180-0c32-45ba-b999-e8ee4cfa7b82`, 140057 ms, 15 model calls, 21 tool calls, zero mutations, noProgress true.
- Target attempt 2: Run `run_8c5dbfde-59c4-49bc-a0f0-d87061dc2218`, 207328 ms, 11 model calls, 17 tool calls, zero mutations, noProgress true.
- Оба Run failed: `Atomic agent made no progress after repeated inspections and a local repair prompt.` Tools: fs.list/read/search. Provider errors и malformed native output не были причиной.
- Full verifier после каждой попытки rejected; исходный verify тоже rejected. Три verification Runs, два execution Runs.
- Wall time continuation 348130 ms; total 26 model calls, 38 tool calls, zero mutations/process calls. Background hash не изменился.
- Final route BLOCKED `repair_target_stalled`; progress 6/10; lifetime attempts 17 → 19, maxAttempts 23; 65 старых Runs сохранены byte-for-byte, итог 70 Runs. Все старые Decisions сохранены.
- Build/test PersonaCore не запускались: route до этих steps не дошёл. Нового PersonaCore diff от continuation нет.
- Automatic model switch и повторное continuation не выполнялись. `PERSONA_BRIDGE_AUTO_START=0` во всех drivers; Bridge не запускался.

Scout выполнен; прогресс acceptance beyond 6/10 не достигнут. Disposable strict PASS подтверждает способность на небольшом gate и не подтверждает успешность данного PersonaCore target. Сохранён следующий конкретный diagnostic case, как предусмотрено STOP условием запроса.

Evidence: `apps/server/data/jabberwock/executor-scout-2026-10-02T08-47-45-628Z/` содержит immutable raw level/smoke artifacts, `capability-profiles.json`, `authoritative-review.json`, `authoritative-selection.json`, исходный acceptance snapshot/audit, подготовленный continuation plan и полный `acceptance-continuation.json`. `acceptance-diagnostic.json` содержит компактный target/attempt/verification export. Raw `selection.json` относится к прежнему preliminary selector; использовать authoritative selection.

Изменения кода ограничены `apps/server/src/jabberwock-memory/executor-scout.ts`, его тестами и тремя scoped drivers в `scripts/`. Проверено: 48 focused tests / четыре suites PASS; server TypeScript build PASS; отдельный TypeScript check трёх drivers PASS. Graphify AST update выполнен. Production Runner, Atomic runtime, provider adapters и verifier implementation не изменены.

Повторное использование: основной driver `scripts/jabberwock-executor-scout.ts`; read-only authoritative review `scripts/jabberwock-executor-scout-review.ts <evidence-directory>`; conditional same-route driver `scripts/jabberwock-executor-scout-continue.ts <evidence-directory> --prepare|--continue`. Continuation guard намеренно требует исходный BLOCKED state на attempt 17 и matching strict evidence; нынешний route на attempt 19 повторно не продолжит.
