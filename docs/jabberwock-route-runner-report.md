# Route Runner: отчёт реализации

## Архитектура и состояние

`RouteRunner` управляет последовательностью существующих Supervisor Steps: `RouteRunner → SupervisorBridge → существующий router → agent/text runtime → существующий provider gate`. На каждый пункт сохраняются execution Run и read-only verification Run. Следующий пункт запускается самостоятельно после принятого assessment; исправление текущего состояния выполняется в ограниченном retry-бюджете.

Состояние хранится в прежней `apps/server/data/jabberwock/working-memory.sqlite`. Добавлена таблица `supervisor_routes`; прежняя таблица `steps` расширена полями маршрута, критериев, попыток и восстановления. Миграция аддитивная, идемпотентная и транзакционная, с SQLite busy timeout. Legacy schema проверяется отдельным тестом с сохранением старых Step/Run.

Перед записью сохраняются SHA-256 исходного и ожидаемого содержимого. После прерывания runner сверяет фактический файл и проводит read-only assessment перед следующим изменением. Проверяется и файл после ошибки инструмента, если запись могла примениться до ошибки. Неопределённые эффекты shell-команды не разрешают автоматический повтор. После трёх проверок, включающих корректный assessment с verdict unknown, локальное исправление допускается только при успешном чтении фактического состояния и полном встроенном журнале с установленными последствиями; критерий при этом не считается выполненным. Неизвестные эффекты требуют внешнего evidence/resolution. Cancel передаёт AbortSignal в прежний runtime; доверенный IPC helper завершает дерево package script и реагирует на исчезновение родителя. SQLite claim исключает повторного владельца и конкурирующие маршруты в одной рабочей папке. Восстановленные маршруты ожидают завершения локального владельца по событию.

## API и совместимость

Добавлены `create_route`, `start_route`, `get_route_state`, `continue_route`, `cancel_route` через Supervisor HTTP и существующий authenticated `/mcp`. `create_route` по умолчанию запускает маршрут сразу; `autoStart: false` позволяет сохранить его до запуска. SSE возвращает изменения компактного состояния. BLOCKED содержит причину, пункт, попытки, evidence, вопрос и варианты. `continue_route` сохраняет решение и продолжает с текущего пункта; опциональный `executionConfig` позволяет явно утвердить другую модель.

Прежние capabilities/project/task/state/execute_step/record_assessment сохранены. Default/fixed routing использует прежний router. Второй database, model scheduler, routing engine, extension lifecycle и транспорт через ChatGPT composer не добавлены. Полная схема HTTP, пример запроса и ограничения описаны в [руководстве](jabberwock-route-runner.md).

## Изменённые файлы

- `apps/server/src/jabberwock-memory/route-types.ts`, `route-input.ts`, `route-runner.ts`: модель, проверка входа и автономное выполнение.
- `apps/server/src/jabberwock-memory/storage.ts`, `service.ts`, `index.ts`: миграция, persistence, claim/recovery и интерфейс памяти.
- `apps/server/src/jabberwock-memory/supervisor-bridge.ts`, `atomic-agent-runtime.ts`, `atomic-tools.ts`: повторное использование Step/Run, журнал мутаций, evidence, ограниченный coding loop и самостоятельная проверка.
- `apps/server/src/routes/jabberwock-supervisor.ts`, `apps/server/src/app.ts`: HTTP/SSE и lifecycle runner.
- `apps/server/src/mcp/server.ts`, `jabberwock-tools.ts`: native MCP operations в прежнем transport.
- `scripts/jabberwock-script-worker.mjs`, `scripts/jabberwock-route-acceptance.ts`: контролируемое дерево package script и драйвер одного реального маршрута.
- `apps/server/src/jabberwock-memory/route-runner.test.ts`, `atomic-tools.test.ts`: новые suites.
- `apps/server/src/jabberwock-memory/storage.test.ts`, `atomic-agent-runtime.test.ts`, `supervisor-bridge.test.ts`: migration/runtime coverage и явный auto-routing в legacy fixtures, которые проверяют auto.
- `apps/server/src/routes/jabberwock-routes.test.ts`, `jabberwock-supervisor.test.ts`, `apps/server/src/mcp/jabberwock-tools.test.ts`: HTTP/native MCP и обратная совместимость.
- `docs/jabberwock-route-runner.md`, этот отчёт; `graphify-out/` обновлён обязательным `graphify update .` (AST-only).

Рабочая папка содержала изменения до начала задачи; они сохранены. Часть существующего Jabberwock кода уже была untracked. Изменения catalog/providers/public ORP и сторонние изменения PersonaCore не включались в реализацию runner.

Последнее обновление graphify: 9962 nodes, 21236 edges, 509 communities; AST-only, **0 LLM tokens**. Один SQL-файл пропущен extractor из-за отсутствующего `tree_sitter_sql`; это ограничение графа, не серверной миграции или её теста.

## Проверки

Профильный прогон: **55 passed, 11 files**. Он покрывает последовательность, автоматический следующий пункт, retry, реальные запись/timeout/read-only verification без второй записи, maxAttempts, continuation с decision и сменой утверждённой модели, cancel, повторный claim, persistence/recovery, legacy schema, общий workspace, очередь восстановления без polling, subprocess descendants, исчезновение родителя, HTTP и native MCP. Отдельный тест с настоящим HTTP/SSE соединением проверяет shutdown: поток закрывается, выполнение получает abort, маршрут остаётся восстанавливаемым. Проверка детектора остановки прогресса использует разные запросы и перекрывающиеся диапазоны одного исходника, затем подтверждает локальный patch по подсказке runtime.

Сборка `@snarkroute/server`: **passed**.

Последний полный серверный прогон после всех изменений: **354 passed, 60 files**.

Полный workspace-прогон: **1104 passed, 1 failed; 26 рабочих пакетов прошли, 1 не прошёл**. Единственный оставшийся сбой — `packages/model-catalog/test/model-catalog-v1-merge.test.ts`, `uses existing model icon filenames for unknown live vendor models`: для Gemini image preview тест ожидает `nano-banana.svg`, текущий каталог возвращает `gemini.png`. Эти файлы runner не менял. Общий прогон выполнен с увеличенными test/hook timeouts и ограничением числа workers, поскольку параллельно работает реальный локальный executor. После последней локальной правки повторены профильный прогон, полные серверные тесты и полный workspace-прогон.

Команды:

```powershell
corepack pnpm --filter @snarkroute/server build
corepack pnpm --filter @snarkroute/server test -- src/jabberwock-memory src/routes/jabberwock-supervisor.test.ts src/routes/jabberwock-routes.test.ts src/mcp/jabberwock-tools.test.ts
corepack pnpm --filter @snarkroute/server test -- --testTimeout=20000 --hookTimeout=20000 --maxWorkers=2 --minWorkers=1
corepack pnpm -r --no-bail test -- --testTimeout=20000 --hookTimeout=20000 --maxWorkers=2 --minWorkers=1
graphify update .
```

## Реальная приёмка

Маршрут `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`, task `task_ec442719-8fed-4ba0-a97d-15a511b45539`, root `I:/PersonaCore/extension`: один маршрут из десяти пунктов для индикатора активности. Использованы существующие Supervisor/router/runtime и локальная фиксированная модель `bonsai-2-27b`; состояние сохраняется в прежней рабочей памяти. Драйвер вызывает один `create_route`; внешних поэтапных `execute_step` — **0**.

Итог: **BLOCKED / verification_exhausted**, пункт 7 «Verify completion and error», execution attempts **2/3**. После последнего восстановления три read-only проверки подряд завершились по timeout **600000 ms** каждая без принимаемого assessment. Исчерпан бюджет проверяющей модели, а не объявлена готовность индикатора. Вопрос сохранён в состоянии: выбрать разрешённую модель/configuration через `continue_route`, предоставить независимо проверенные evidence либо явно разрешить новый ограниченный цикл текущей модели. Фиксированная модель автоматически не менялась.

Сохранено **6/10** завершённых пунктов, **3** lifetime retries, внешних `execute_step` — **0**. При этом assessment пункта 6 оказался ошибочным: toolbar wiring фактически не готово. Пункты build/test/final diff остались pending. Выполненных package scripts PersonaCore в журнале **0**, поэтому их успешность не заявляется. После завершения активных Runs этого маршрута **0**; процесс драйвера завершён.

Состояние сохранено в [JSON приёмки](../apps/server/data/jabberwock/acceptance-route_fd271b28-4bd7-4bf3-b215-83a2a607cc09.json). Во время разработки драйвер восемь раз перезапускался для загрузки исправлений bounded runtime; после каждого перезапуска восстанавливался тот же route ID и сохранялись завершённый прогресс и попытки. Поэтому этот прогон нельзя называть непрерывным выполнением без вмешательства в инфраструктуру.

В третьей попытке toolbar executor удалил дублирующий blink-блок одним `fs.patch` в `I:/PersonaCore/extension/src/background/index.ts`. Последующий model call завершился по timeout; запись была сохранена и не повторялась. Старый assessment переоценил наличие подключения к lifecycle: прямое чтение показывало определение функции без вызовов. После этого инструкции runtime/verification уточнены: проверять каждый пункт критерия, реальные invocations и event registrations, искать counterevidence, не принимать unused definitions за готовое поведение. Эта модельная ошибка учитывается при независимой финальной проверке приёмки.

Финальная независимая проверка подтвердила одну реализацию blink и отсутствие вызовов `setJabberwockToolbarActive`/подписки `onChanged` в background. SHA-256 файла после единственной записи: `5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8`; он совпадает с ожидаемым hash из mutation journal. Изменения PersonaCore вручную для обхода приёмки не вносились.

## Ограничения

Критерии оценивает выбранная модель по tool evidence; это не формальное доказательство поведения UI. Нужны реальная read/search/diff проверка и явные exit results для build/test критериев. Слабая или медленная модель может исчерпать bounded бюджет. Runner не заменяет fixed model самовольно: для смены нужен явный continuation decision/configuration.

Нормальная конфигурация — один Supervisor process. Активного владельца в другом процессе recovery не забирает; cancel выполняется у владельца. Неопределённые эффекты shell требуют внешнего evidence/resolution. Text runtime проверяет текст, не файловое состояние. Новый extension progress UI не добавлялся; API/SSE являются источником истины. Уже запущенный сервер необходимо перезапустить на новой версии для появления endpoints/tools.
