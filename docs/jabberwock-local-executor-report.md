# Jabberwock: локальные executors после bounded-verifier fix

Дата: 1 октября 2026. Итог: **BLOCKED / max_attempts, 6/10 → 6/10**. Исходный route `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`, Task `task_ec442719-8fed-4ba0-a97d-15a511b45539`, authoritative DB `data/jabberwock/working-memory.sqlite` сохранены. Новых acceptance routes и внешних acceptance `execute_step` — **0**. PersonaCore вручную не редактировался.

Основные проверяемые данные: [компактный audit](../apps/server/data/jabberwock/local-executor-review.json), [полный continuation с Runs](../apps/server/data/jabberwock/executor-continuation-llama3_latest.json), [native API state](../apps/server/data/jabberwock/local-executor-native-api-state.json), [native catalog](../apps/server/data/jabberwock/local-executor-native-catalog.json).

## Доступные модели и фактическая совместимость

`gpt-oss-20b` / `gpt-oss:20b` не экспонируется существующим SnarkRoute catalog, Bonsai `/v1/models` или Ollama `/api/tags`; `lms ls --json` вернул `[]`. Проверены установленные runtime-каталоги и доступные aliases, без сканирования всего диска. Модель не скачивалась, compatibility не придумывалась, duplicate logical registration не создавалась.

| Модель / logical ID в ai.text | Provider / endpoint | Native tools | JSON / фактический AtomicAgentRuntime | Context модели / рабочий |
| --- | --- | --- | --- | --- |
| `bonsai-2-27b` | `local_openai`, `127.0.0.1:8080/v1` | Заявлены Jinja template; чтения tools подтверждены прежними Runs | Прежний executor не сделал corrective edit; оставлен verifier | 32768 / 32768 |
| `qwen3:8b` | `local_openai`, `127.0.0.1:11434/v1` | `/api/show`: completion, tools, thinking | JSON/final возвращает, обязательное чтение пропускает; smoke FAIL | 40960 / 8192 |
| **`llama3:latest`** | **`local_openai`, `127.0.0.1:11434/v1`** | Native tools не заявлены | **JSON tool_actions + реальный fs.read + structured final PASS; corrective edit FAIL** | 8192 / 8192 |
| `gemma3:12b` (временный discovery для smoke) | `local_openai`, `127.0.0.1:11434/v1` | completion, vision; native tools не заявлены | JSON tool request и fs.read работают, bounded final не завершён | 131072 / 8192 configured |
| `gemma3:27b` (установлена, не выбрана) | Ollama, `127.0.0.1:11434/v1` | completion, vision | Не проверялась в Atomic runtime: более тяжёлая модель; 12B уже не уложилась в smoke timeout | 131072 / не загружена |
| `LLaVA:latest` (установлена, не выбрана) | Ollama, `127.0.0.1:11434/v1` | completion, vision | Agent/JSON совместимость не установлена; vision-модель не объявлена coding executor | 32768 / не загружена |

Ollama также содержит `deepseek-v3.1:671b-cloud`; она исключена. Для всех проверявшихся executors configured output cap — **2048 tokens**, temperature 0, JSON object mode. Отдельного меньшего output cap у installed Ollama models не обнаружено. Bounded verifier сохраняет свой cap 768. Native tools metadata и JSON tool-протокол AtomicAgentRuntime — разные интерфейсы: наличие первого не доказывает совместимость со вторым. [Официальная совместимость Ollama](https://docs.ollama.com/api/openai-compatibility) описывает JSON mode и reasoning control; фактическая совместимость установлена только smoke.

Добавлен минимальный opt-in `LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON`: существующий generic local adapter выбирает endpoint по explicit physical model allowlist. Primary Bonsai endpoint, его credentials и canonical alias сохранены. Additional endpoint принимает только loopback HTTP, cloud/duplicate IDs отвергаются, primary API key не передаётся, inference fallback отсутствует. Discovery использует существующую нормализацию Model Gateway. Raw catalog IDs `local_openai:llama3:latest` / `local_openai:qwen3:8b` разрешаются через существующие ai.text aliases `llama3:latest` / `qwen3:8b`.

## Isolated smoke: до расходования route attempts

Все smoke использовали существующие SupervisorBridge → router → AtomicAgentRuntime → Model Gateway → local adapter, временный workspace, in-memory Task без Route, read_only, 3 turns, cap 2048, timeout 120000 ms. Требовались ровно один реальный `fs.read` и final JSON с UUID, доступным только в файле. PersonaCore не затрагивался.

| Smoke | Результат | Latency | Реальные tools |
| --- | --- | --- | --- |
| Qwen, исходный Ollama process | FAIL: timeout | 120010 ms | 0 |
| Llama 3 | **PASS**: точный UUID, JSON final, завершение turn | **61346 ms**, включая около 44840 ms cold load | **1 fs.read**, 2 model requests |
| Qwen, контролируемый повтор | FAIL: выдуманный `123e4567-e89b-12d3-a456-426614174000` | 80129 ms | 0 |
| Qwen, explicit reasoning_effort none | FAIL: «Current instruction is verified and finished», без нужного JSON/чтения | 1296 ms | 0 |
| Gemma 3 12B | FAIL: чтение выполнено, final timeout | 120017 ms | 1 fs.read, 2 model requests |

После исходного Qwen timeout наблюдалось 15789 MiB занято на 16384 MiB GPU. Для контролируемого повтора перезапущен только Ollama, запущенный этой диагностикой: existing models path `I:/AI/LLma/models`, `OLLAMA_GPU_OVERHEAD=2147483648`, context 8192, parallel=1, loaded models=1, `OLLAMA_NO_CLOUD=1`. Bonsai process/model/verifier не менялись. Повтор достиг около 30 tokens/s, но провалил обязательное чтение. Это не доказывает, что причиной первого timeout была исключительно VRAM. Configuration и воспроизводимый launcher: [snapshot](../apps/server/data/jabberwock/executor-ollama-config.json), [script](../scripts/start-jabberwock-executor-ollama.ps1). [Назначение GPU_OVERHEAD](https://github.com/ollama/ollama/blob/main/envconfig/config.go) — резерв VRAM.

Gemma выгружена после smoke. Qwen reasoning experiment не сохранён в production config. Ни Qwen, ни Gemma не получили acceptance attempts.

## Единственный continuation и сохранённая история

После PASS Llama вызван один `continue_route` с explicit `routingMode=fixed`, `model=llama3:latest`, agent/read_write, maxToolTurns=16. Сохранён Decision `decision_e8fe7a4e-26e9-43c7-9c79-20e1253a670d`: «User explicitly approved changing executor model and continuing the same route». Он виден в native route state.

Attempts текущего step: **5 → 8**, maxAttempts **5 → 8**, без обнуления. Три новых attempts — 6, 7, 8. Все шесть completed steps, десять Step IDs, Task/Route IDs и прежние 40 Runs сохранены; теперь Runs 46. Total retries: 6 → 9.

Verifier явно pinned на `bonsai-2-27b`, endpoint 8080. Runtime остаётся **BoundedVerifierRuntime**, read_only, timeout 90000 ms, прежние policies и limits. Это предотвращает наследование нового executor model. Новые source checks отвергли missing wiring за 82/63/62 ms без inference: 0 verifier model calls. Heavy verifier не возвращался.

| Новый execution Run | Attempts | Model requests по provider usage / записанное старым counter | Tools | Latency | Итог |
| --- | --- | --- | --- | --- | --- |
| `run_085c00f8-b046-4aaa-a25d-94bd3a449d3b` | 6 | **7 / 8** | 7 | 34532 ms | stalled inspections |
| `run_b7b21718-e20a-4ad4-a760-3661cda27aab` | 7 | **9 / 10** | 9 | 36437 ms | stalled inspections |
| `run_d6eaaf4f-4ec3-4d0a-a8aa-c576c46acb57` | 8 | **4 / 5** | 4 | 16187 ms | stalled inspections |

Фактически **20** успешных local model requests и 20 tools; это подтверждают provider usage и 20 `started` events в continuation log. Суммарная execution latency 87156 ms. Provider errors/empty output у Llama отсутствуют. Все три attempts остановлены progress detector после повторных чтений и repair guidance, задолго до 16-turn/600000-ms limit. Mutation events и package-process receipts — **0**.

При audit обнаружен telemetry off-by-one: stalled exit считал `history.length + 1`, хотя следующего запроса не было. Добавлен regression test (4 actual requests считались 5), затем исправлен явный counter перед model request. Поведение, prompt, budgets и история этих Runs не менялись; старые metadata не переписаны. Новых acceptance attempts после telemetry fix не было.

Повторный restart native API для применения именно telemetry fix был отклонён automatic approval review: `blocked by policy`, без более конкретной причины. API не останавливался и продолжает обслуживать актуальный route state/catalog/Decisions; counter fix сохранён в исходниках и проверенной сборке, для работающего процесса требуется следующий разрешённый restart.

## Финальная source verification и ограничение

`src/background/index.ts` SHA256 до/после: `5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8`.

- `setJabberwockToolbarActive`: 1 implementation, **0 actual calls**.
- `chrome.storage.onChanged.addListener`: **0 actual calls** в background.
- `chrome.storage.session.get`: 2 calls, недостаточные для toolbar wiring.
- `clearInterval`: 1 call; `started` и `jabberwock-supervisor:` literals в background отсутствуют.
- Dispatcher содержит существующие `started` и `completed` records; интеграции toolbar с ними нет.

PersonaCore files changed новым Runner cycle: **0**. Build command PersonaCore: **не запускалась**, exitCode отсутствует, receipts 0. До build/test/final-diff steps Runner не дошёл. Успешного build, lifecycle wiring, overlap handling или final acceptance не заявляем.

**A — model capability:** Llama выполняет простое чтение/JSON, но в corrective task не запросила ни одного edit. Ответы занимали 29–60 completion tokens, максимум наблюдённого prompt+completion 7179 tokens при context 8192: output cap/context exhaustion не объясняют эти attempts.

**B — atomic tool interface:** read/search реально работали без tool errors; isolated unit tests подтверждают fs.patch/write. В этих acceptance Runs модель вообще не запросила mutation, поэтому failure write implementation ими не доказан.

**C — prompt/tool protocol:** Qwen native tools capability не обеспечила соблюдения JSON tool_actions; smoke ловит final без чтения. Llama resolution и counterevidence присутствовали в первых 8000 chars supervisor prefix во всех attempts; потеря этого Decision при clipping исключена. Чувствительность модели к формулировке/JSON harness остаётся возможной причиной; экспериментом она не отделена от coding capability.

**D — provider adapter:** local Llama responses и usage приходили, endpoint 11434 подтверждён, inference fallback отсутствовал. Отдельный Qwen cold timeout и Gemma final timeout зафиксированы. Текущий bottleneck Llama не сопровождался provider error.

**E — Route Runner:** история/IDs/budgets сохранены, bounded verifier обнаружил counterevidence, progress detector остановил loop, max_attempts заблокировал дальнейшее исполнение. Доказанного orchestration failure нет. Telemetry counter исправлен отдельно. Два кандидата, прошедших smoke и проваливших corrective edit, не получились: PASS был только у Llama; остальные не допущены после FAIL.

Remaining limitation: **выбранный локальный executor + текущий JSON tool-протокол повторяют inspections вместо corrective edit**. Переход к другим prompts/native-tools или более сильному локальному coding model требует отдельного проверяемого эксперимента, а не очередного blind continuation.

## Проверки SnarkRoute и Persona Bridge

Focused provider/runner/verifier suite: **45 tests PASS**. После telemetry fix: AtomicAgentRuntime + RouteRunner **29 tests PASS**, включая regression. Server build: **exit 0**. Native API reload: route state/catalog/health и готовый прежний Bonsai подтверждены. Graph обновлён AST-only; новые dependencies и новая routing/scheduling architecture не добавлялись.

Persona Bridge не включался, ChatGPT UI/browser automation не использовалась, все запуски API/diagnosis имели `PERSONA_BRIDGE_AUTO_START=0`. Клиентский OFF — заданное пользователем состояние, независимо через UI не проверялось. Уже существовавший companion listener PID 14944 на 8766 не является доказательством включённого клиентского переключателя; его состояние этой задачей не менялось. Cloud/KIE/RuTronix inference/fallback отсутствовали.
