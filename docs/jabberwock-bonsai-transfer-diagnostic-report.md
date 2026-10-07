# Bonsai: перенос strict Scout gate на реальный repair target

Диагностика завершена 3 октября 2026 года по московскому времени. Наиболее сильное наблюдение: **на полной копии настоящего файла Bonsai сделал patch после добавления deterministic context pack, тогда как без него дважды остановился на чтениях**. Это указывает на локализацию контекста как вероятную причину отсутствия мутаций. Однако полученный patch **не выполняет полный lifecycle criterion**: overlap неисправен, восстановление activity из session state отсутствует. Strict Scout PASS не гарантирует такой перенос.

Все model repairs выполнены только в отдельных временных workspace. Реальный маршрут, его Runs/Decisions, PersonaCore и production implementation не изменены. Persona Bridge не запускался.

Основные доказательства находятся в [каталоге диагностики](../apps/server/data/jabberwock/bonsai-transfer-diagnostic-2026-10-02T21-36-15-660Z/): [comparison.json](../apps/server/data/jabberwock/bonsai-transfer-diagnostic-2026-10-02T21-36-15-660Z/comparison.json), [lifecycle-review.json](../apps/server/data/jabberwock/bonsai-transfer-diagnostic-2026-10-02T21-36-15-660Z/lifecycle-review.json), [audit.json](../apps/server/data/jabberwock/bonsai-transfer-diagnostic-2026-10-02T21-36-15-660Z/audit.json). Сохранены полные provider request/response traces, tool journals, before/after hashes и результаты обоих deterministic verifier checks после каждой попытки.

Использованы настоящий `SnarkRouteAtomicAgentRuntime`, Bonsai `bonsai-2-27b`, `local_openai`, native tools, `read_write`; 16 tool turns, generation cap 2048, temperature 0, прежний timeout 600000 ms и максимум две попытки на experiment. Другие модели и fallback не использовались. RouteRunner не запускался. Процессы, build и test внутри model attempts не вызывались; provider errors и malformed outputs — 0 во всех пяти попытках.

Точный исходник `I:/PersonaCore/extension/src/background/index.ts`: **12181 байт, 11741 JavaScript UTF-16 code units, 184 строки**. A/B/D начинались с одинаковой побайтовой копии. Дополнительно скопированы три настоящих модуля `jabberwock/dispatcher.ts`, `client.ts`, `protocol.ts` для inspection; их изменение запрещено и не наблюдалось. Остальные imports оставлены внешними: это source-only fixture, полный проект не реконструировался.

| Experiment | Source / context | Mutations | Assigned target resolved | Model calls / tools | Prompt tokens: initial → peak | Wall time | Outcome |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| A | Полный exact source, minimal context | 0 | Нет | 21 / 27 | 1780 → 5691; 1780 → 5579 | 181.587 s | Две inspection stalls |
| B | Тот же полный source + factual pack 4375 chars | 1 | Да | 8 / 7 | 2918 → 6846 | 151.612 s | PASS одного target; полный lifecycle FAIL |
| C | Не запускался; подготовлен реальный slice 4712 chars | — | — | 0 / 0 | — | — | Пропущен: B разрешил assigned target |
| D | Тот же полный source, minimal context, scoped semantic target | 0 | Нет | 23 / 27 | 2018 → 5836; 2018 → 5947 | 211.082 s | Две inspection stalls |

Wall time таблицы включает experiment bookkeeping. Время individual attempts: A 83111 / 98457 ms; B 151605 ms; D 119097 / 91968 ms. Везде выполнялась точная проверка assigned target и отдельно **полная исходная Step 6 source policy**. Последняя не принята ни в одном experiment. `passed: true` у B в raw comparison означает mutation + resolution одного target + сохранение исходных functions/imports/scope; это не acceptance Step 6. Lifecycle review записан отдельно, чтобы эти результаты не смешивались.

Initial system text A/B/D одинаков: 713 chars. User instruction A: 2765 chars; B: 7141 chars, включая pack 4375 chars и разделяющий newline; D: 3791 chars. Provider textual prompt на первом запросе, без сериализации tool schemas: A 3478 chars, B 7854 chars, D 4504 chars. Tokens в таблице — фактический `prompt_tokens` provider, а не оценка по символам. Pack содержит оригинальные line-anchored snippets helper, imports/declarations, dispatch branch, session reads, observed counts и точные policy/counterevidence. Нового implementation или готового patch в нём нет. Политика повторяется в основном instruction и pack; влияние этого повторения отдельно не изолировано.

В A executor читал основной файл по диапазонам, затем dispatcher/client/protocol; повторные и пустые чтения закончились runtime no-progress guard. Это не доказательство, что модель видела лишь первые 4000 символов: фактически она запросила последующие диапазоны основного файла. При этом native runtime ограничивает recent tool history и каждый tool output, поэтому получение региона инструментом не означает его постоянного присутствия в следующем prompt. Pack сохранял выбранные факты непосредственно в исходном user instruction, независимо от вытеснения tool history.

У реальных двух repair Runs stored `Run.prompt` имеет 19226 chars, но начальный provider prompt — **3653 chars / 1796 tokens**, пики — 5839 / 5775 tokens. Capture первого native request произведён без provider/tool execution. Native system извлекает PROJECT/TASK GOAL/CONSTRAINTS; весь historical ledger, KNOWN FACTS, COMPLETED STEPS и RELEVANT ARTIFACTS модели не передаётся. Один recovery decision остаётся в текущем instruction реального запуска. A с minimal context почти не уменьшил фактические initial tokens и повторил stall. Поэтому перегрузка всеми предыдущими Runs не подтверждается; удаление оставшегося route context само по себе не помогло. Ошибок context overflow или provider timeout не наблюдалось.

B изменил только существующую trusted `JABBERWOCK_SUPERVISOR` branch: добавил `setJabberwockToolbarActive(true)` перед execute и `false` в success/error callbacks. Helper, imports, остальные исходные functions и три support modules сохранены. Это настоящая локальная mutation в полном source, а не dummy top-level call. Полученный исходник сохранён как [B-captured-index.ts](../apps/server/data/jabberwock/bonsai-transfer-diagnostic-2026-10-02T21-36-15-660Z/B-captured-index.ts).

Дополнительные probes исполняют извлечённый фактический message callback с mocked helper/activity recorder и управляемыми dispatcher promises; Chrome, файловая система и реальный extension не вызываются:

| Probe B | Observed activity | Result |
| --- | --- | --- |
| Один success | `true → false` | Activation/cleanup наблюдаются |
| Один error | `true → false` | Activation/cleanup наблюдаются |
| Два запроса, первый success | `true → true → false`, второй ещё pending | Overlap FAIL |
| Два запроса, первый error | `true → true → false`, второй ещё pending | Overlap FAIL |

Существующий helper при `false` очищает blink timer; следовательно ранний `false` действительно противоречит требованию сохранять activity при другом pending request. Это focused wiring evidence, не browser integration test. Полная source policy также обнаруживает четыре оставшихся нарушения: нет matching `chrome.storage.session.get(null)`, storage change listener, scoped prefix predicate и scoped `Object.is(..., 'started')`. Existing session reads относятся к Persona pending/processed, а не к восстановлению Jabberwock activity.

**Underspecification подтверждена отдельно.** На отдельной disposable копии синтетический `setJabberwockToolbarActive(false)` на уровне module удовлетворяет исходному `call_count ≥ 1`, хотя не подключает activity к lifecycle. Это static counterexample, 0 model calls; модель этот patch не получала. Candidate в уже существующем CallPredicate:

```json
{
  "callee": "setJabberwockToolbarActive",
  "arguments": [{ "index": 0, "equals": true }],
  "within": {
    "callee": "chrome.runtime.onMessage.addListener",
    "callbackArgument": 0
  }
}
```

Он требует activation call внутри зарегистрированного message callback и отклоняет безусловный module-level idle toggle. Callback уже существует в реальном source; новое имя refresh function не предписывается. Candidate проверяет лишь частичное start-wiring evidence. Текущий CallPredicate не выражает trusted branch guard, корректную concurrent aggregation, success/error cleanup или derivation activity из storage state. В исходном background ещё нет storage listener/refresh function, поэтому target «вызов внутри конкретной refresh function» предписал бы несуществующую архитектуру.

D на fresh full source использовал этот candidate и minimal context **без pack B**. Обе попытки завершились inspection stall, 0 mutations. Одного уточнения target оказалось недостаточно для перехода к действию. D не проверяет совместное воздействие candidate + pack. Production policy не менялась.

Диагноз по разделяемым факторам:

- **Context localization:** наиболее вероятный bottleneck для отсутствия мутаций в данном target. A FAIL + B target PASS на одинаковом полном source. Это bounded наблюдение: две попытки A и одна B; оно не устанавливает универсальную надёжность pack и не изолирует каждый его компонент.
- **Source complexity:** полный файл сам по себе не запрещает Bonsai сделать локальный patch — B это показал. Влияние complexity на корректность всего lifecycle остаётся возможным; C по условию задачи не запускался.
- **Target contract:** plain count слишком слаб для исходного lifecycle criterion. Уточнение нужно для качества evidence, но D показывает, что оно само по себе stall не устранило. Даже candidate не способен доказать overlap/init.
- **Model capability:** Bonsai способен на ограниченный repair в настоящем source при локализованном контексте. Способность корректно выполнить полный real lifecycle здесь не подтверждена; patch B имеет конкретный concurrency defect. Прежний Scout проверял маленькие, более явные coding patterns и не является доказательством real acceptance.
- **Route/history effects:** full ledger не входил в actual native prompt, а minimal context A не помог. Эта гипотеза не поддерживается как основная причина наблюдаемого stall.

Deterministic context pack обоснован как направление для последующей локализации source context. Более semantic target и focused lifecycle behavior checks нужны для различения частичной mutation и правильного результата. В этой задаче получен диагноз; production fix, бесконечный prompt engineering и PersonaCore continuation не выполнялись.

Финальный audit: route/Runs/Decisions unchanged, PersonaCore target/support unchanged, шесть production modules (`route-runner`, `verification-policy`, `bounded-verifier`, `atomic-agent-runtime`, `atomic-tools`, `native-tools`) unchanged. У реального маршрута осталось 70 Runs; новых Decisions и additionalAttempts нет. SHA256 оригинала до/после:

```text
5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8
```

Добавлены только diagnostic scripts/context tests и этот отчёт. Focused context tests: 2 PASS; TypeScript noEmit для четырёх diagnostic files: PASS. Восемь captured callback probes записаны как observed evidence, включая обнаруженные FAIL; они не объявляются успешными lifecycle tests.
