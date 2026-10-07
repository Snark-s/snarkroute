# Jabberwock production-MVP — 3 октября 2026

P0 завершён: внешняя coding-эскалация реализована; PersonaCore activity исправлен напрямую Codex; существующий маршрут завершён. P1 реализован и прошёл tests/build; **live restart не выполнен**, поскольку текущий API принадлежит прежнему способу запуска. Для применения новых API/control endpoints нужен первый управляемый запуск по процедуре ниже. Persona Bridge OFF.

## 1. Что реально работает

- Runner ограничивает работу local executor над одним unresolved atomic repair target двумя попытками, сохраняет coding escalation и принимает внешнее исправление только после отдельной verification.
- PersonaCore background и Workshop используют существующие session lifecycle records; success/error и пересекающиеся запросы покрыты тестами настоящего dispatcher/background и React panel.
- Activity route `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`, task `task_ec442719-8fed-4ba0-a97d-15a511b45539`: **COMPLETED, 10/10**, подтверждено GET работающего API. Новый маршрут не создавался.
- Прежние 70 Runs и Decisions неизменны; теперь 82 Runs. [Аудит истории](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-mvp-snapshot-20261003-012827/history-audit.json).

Перед работой сохранены git status/diffs, untracked inventory, consistent SQLite backup, route state и процессы. Чужие working changes сохранены; reset/checkout не выполнялись.

## 2. External escalation

State использует существующий `blocked` с различимым `blockedReason.kind`: `coding_escalation`, `external_decision`, `verification`. Packet хранится в существующем persisted blocked JSON; новая DB/schema migration не требуется. Для legacy coding block packet может быть восстановлен из истории.

Доступ: GET `/api/jabberwock/supervisor/routes/:routeId/escalation` и MCP `jabberwock_get_escalation`. Packet содержит route/task/step, instruction/repairTarget, original goal/criteria, expectedCondition/counterevidence, source paths/changed files, attempts/model/protocol, tool results/Decisions, recommended verification и reason.

Существующий `continue_route` принимает `resolution` и `externalResolution: { stepId, evidence, changedFiles }`. Он сохраняет отдельные Decision/Run, ставит verification pending и проверяет workspace перед продолжением. Внешнее утверждение о результате не даёт PASS. Rejected/unknown остаются coding escalation. Старые Runs не переписываются; внешняя submission и её acceptance различимы. Для этой операции запрещено одновременно добавлять local attempts или менять execution/verification config.

После двух unresolved попыток того же target третьего local execution нет, включая случай частичного прогресса. Настроенный executor сохраняется; Scout автоматически не вызывается. Focused tests проверяют success/retry/cap, packet, ложный external claim, настоящий source fix, unknown, сохранение истории, SQLite reopen/cancel и legacy execute_step.

## 3. PersonaCore activity

Изменены [background/index.ts](I:/PersonaCore/extension/src/background/index.ts), [Workshop.tsx](I:/PersonaCore/extension/src/sidepanel/Workshop.tsx), existing background test и новые lifecycle/panel tests.

Activity — наличие хотя бы одной session записи `jabberwock-supervisor:*` со state `started`. Listener устанавливается перед initial read; `chrome.storage.onChanged` инициирует новый snapshot. Generation guard отбрасывает устаревшие reads. Завершение одного запроса не гасит indicator, пока другой active. Существующие toolbar helper/единственный blink timer и reduced-motion CSS сохранены; polling request lifecycle не добавлен. [Source-preservation audit](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-activity/source-preservation-audit.json) подтверждает сохранение всех первоначальных background statements.

Реальный full extension test: **144 PASS**; TypeScript и full extension build: **exit 0**. Проверены initial restoration, success/error, overlapping success/error, deletion, stale reads, cleanup/no polling. Live визуальная проверка загруженного browser extension не выполнялась.

Fix внесён напрямую Codex, затем external resolution записан в тот же activity route. Первоначальный bounded verifier дал unknown/timeout и оставил block. После этого использован явно task-scoped external tool lane: отдельный read-only verifier проверил первоначальную source policy через существующий AST verifier и свежие реальные test/build receipts. Steps 7–10 выполнили настоящие tool/process checks и финальный source/diff inspection. В этой lane нет model calls и нового generic predicate framework; provenance — `manual_external`. [Независимая проверка](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-activity/external-independent-verification-6.json), [итог маршрута](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-activity/route-after-resolution.json).

## 4. SnarkRoute restart

Расширен существующий `scripts/start-launcher.mjs`: launcher остаётся живым owner одного API child. Control loopback port 5176: GET `/status`, POST `/restart`. API `/api/system/restart` проксирует owner; private ownership/shutdown endpoints требуют owner token, точный PID и активную команду остановки. Token в browser не передаётся.

Owner выполняет acknowledge → graceful close → child exit → port closed → start того же configured server → authenticated ownership/health. Есть bounded waits, duplicate guard, failed-start cleanup, IPC parent-loss cleanup. По занятому порту чужой процесс не принимается во владение. Provider apps/Canvas/Workshop preview не перезапускаются.

Workshop и extension panel получили кнопку «Перезапустить SnarkRoute», disabled/progress/success/error и восстановление уже активной операции. Они читают control endpoint напрямую, поэтому завершение restart не зависит от живого API и не требует page refresh. Polling ограничен completion restart. Extension control не использует Persona Bridge.

Проверки: owner/bridge **14 PASS**, restart API/lifetime **8 PASS** (также входят в server suite), launcher **8 PASS**, extension restart client/React test входят в **144 PASS**. Проверены правильный package/process, duplicates, чужие origins/unmanaged owner, start failure, timeout, port closure и graceful cleanup. Это tests, **не доказательство live restart**.

**Live restart: NOT EXECUTED.** На финальной проверке API 4317 — PID 26024, запущенный прежним способом, без нового handler/owner; preview 5172 — PID 53016. Их принудительная остановка не выполнялась. Control 5176 не запущен. Новый owner не может безопасно захватить прежний API.

### Точная ручная проверка после первого управляемого запуска

1. Остановить прежний API через его исходный terminal/launcher (Ctrl+C/Stop), убедиться, что 4317 свободен. Не использовать общий shutdown, который затрагивает другие приложения.
2. В PowerShell запустить owner и оставить этот terminal открытым:

```powershell
Set-Location 'Y:\Процесс\SnarkRoute'
$env:PERSONA_BRIDGE_AUTO_START = '0'
if (Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue) {
  throw 'Прежний API ещё работает: остановите его через исходный способ запуска.'
}
node scripts/start-launcher.mjs --no-browser
```

3. Во втором PowerShell выполнить controlled restart:

```powershell
$before = Invoke-RestMethod 'http://127.0.0.1:5176/status'
if (!$before.managed) { throw 'Launcher не владеет API' }
$requested = Invoke-RestMethod 'http://127.0.0.1:5176/restart' -Method Post -ContentType 'application/json' -Body '{}'
$deadline = (Get-Date).AddSeconds(180)
do {
  Start-Sleep -Milliseconds 700
  $after = Invoke-RestMethod 'http://127.0.0.1:5176/status'
  if ($after.operation.id -ne $requested.operation.id) { throw 'Restart operation изменилась' }
} while ($after.operation.state -notin @('healthy', 'error') -and (Get-Date) -lt $deadline)
if ($after.operation.state -ne 'healthy') {
  if ($after.operation.error) { throw $after.operation.error }
  throw 'Restart timeout'
}
if ($before.serverPid -eq $after.serverPid) { throw 'PID не изменился' }
Invoke-RestMethod 'http://127.0.0.1:4317/api/health'
$after | Select-Object managed, launcherPid, serverPid, operation
```

Для UI проверки открыть собранную Workshop; при первой установке загрузить новый `I:/PersonaCore/extension/dist` обычным extension Reload. Нажать кнопку, проверить disabled/progress/готовность и новый PID. Последующие restart не требуют refresh страницы. Initial deployment не выполнялся через browser automation.

## 5. fs.read ranges

`startLine/endLine` уже реализованы: 1-based integer bounds, прежний default сохранён. Новых изменений не потребовалось. Focused `atomic-tools` tests, включая range/реальный process exit/cancellation cleanup, **5 PASS**.

## 6. Builds/tests

Все перечисленные финальные команды завершились **exit 0**:

| Проверка | Результат |
| --- | --- |
| Server focused Vitest, 10 files | 67 PASS |
| Server TypeScript build | PASS |
| Node launcher owner + existing bridge tests | 14 PASS |
| Launcher Vitest | 8 PASS |
| Launcher TypeScript + Vite build | PASS |
| PersonaCore full Vitest, 8 files | 144 PASS |
| PersonaCore TypeScript noEmit | PASS |
| PersonaCore full background/panel/content build | PASS |
| Task-scoped activity driver typecheck | PASS |
| `graphify update .`, AST-only | PASS, exit 0 |

Логи: [server tests](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-server-focused-tests.log), [owner tests](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-launcher-control-tests.log), [launcher tests](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-launcher-final-tests.log), [launcher build](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-launcher-build.log), [extension tests](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-persona-final-tests.log), [extension build](Y:/Процесс/SnarkRoute/apps/server/data/jabberwock/production-persona-final-build.log). Launcher Vitest напечатал existing WebSocket port-in-use warning; тесты завершились успешно. Full monorepo suite не запускался: затронутые packages проверены отдельно.

## 7. Реальные blockers / ограничения

- Первый managed cold start нужен для загрузки новых server endpoints и включения restart button. Текущий live API продолжает работать со старым кодом.
- Live restart и visual browser/extension smoke ещё не выполнены; точная процедура выше. Source/lifecycle/tool verification и builds завершены.

## 8. Что намеренно не исследовалось

Новые модели/downloads/benchmarks/Scout runs, prompt/context experiments, embeddings/vector DB, новый planner/scheduler/router, новая memory DB и cloud fallback. Persona Bridge остановлен, `PERSONA_BRIDGE_AUTO_START=0`; port 8766 закрыт. Browser/ChatGPT UI automation не использовалась. Новых dependencies не добавлено.

## 9. Changed files

SnarkRoute, только изменения этой ночной задачи:

- `apps/server/src/jabberwock-memory/{route-types.ts,route-input.ts,route-runner.ts,route-escalation.test.ts}`;
- `apps/server/src/routes/{jabberwock-supervisor.ts,system.ts}`, `apps/server/src/mcp/jabberwock-tools.ts`;
- `apps/server/src/services/launcher-restart.ts`, `apps/server/src/server.ts`, `apps/server/test/{launcher-restart.test.ts,launcher-lifetime.test.ts}`;
- `scripts/{start-launcher.mjs,launcher-control.mjs,launcher-control.test.mjs,jabberwock-production-activity.ts}`;
- `apps/launcher/src/{main.tsx,styles.css,RestartSnarkRoute.tsx,restartClient.ts,restartClient.test.ts}`;
- root `.env`: AUTO_START=0; этот report, локальные snapshot/evidence/build outputs и AST knowledge-graph update.

PersonaCore `I:/PersonaCore/extension`: `src/background/index.ts`, `src/sidepanel/Workshop.tsx`, `src/jabberwock/restart.ts`, `tests/{persona-background.test.ts,jabberwock-activity.test.ts,jabberwock-panel-activity.test.ts,jabberwock-restart.test.ts}` и rebuilt dist. Preexisting unrelated/untracked изменения сохранены.

## 10. Первая задача для ежедневного использования

После managed start дать небольшой реальный coding route: добавить «Скопировать путь» к одному существующему local result, с одной source acceptance policy и focused package test. Использовать настроенный local executor; после двух unresolved попыток получить escalation packet, исправить конкретный step внешним coding executor, отправить `continue_route.externalResolution` и принять результат только после verifier PASS. Не повышать budget и не запускать Scout при первом затруднении.
