# Дневной отчёт 21.10.2026 — snarkroute-restart-race

Ветка: `build/2026-10-21-snarkroute-restart-race`.

## Сделано

- Найдена причина падения Vitest: `scripts/launcher-control.mjs` импортировал `scripts/windowless-launch.mjs` с hashbang `#!/usr/bin/env node`; при загрузке `.mjs` через Vitest/Vite (`vm.Script`) hashbang оставался недопустимым токеном. Удалён только hashbang: все найденные вызовы запускают файл через `node <file>`.
- Подтверждено, что `apps/server/src/server.ts` при импорте не запускает сервер: тест использует только экспортированный `listenWithPortRetry`; `startServer()` не вызывается.
- Сохранена защита restart race: `shutdown → выход старого child → свободный API-порт → start → health`; добавлены отдельный лимит ожидания порта, отказ от duplicate start и сброс ownership после закрытия child.
- В `server.ts` добавлен retry `listen` только для `EADDRINUSE`: 10 повторов с паузой 500 мс.
- Добавлены/сохранены тесты последовательности restart и retry `listen`; node:test обновлён под диагностическое сообщение.
- `graphify update .` выполнен после изменений: 12177 узлов, 26613 связей, 621 сообщество. SQL-файл graphify пропустил из-за отсутствующего `tree_sitter_sql`; к этой задаче не относится.

Живые Шорёк `:4890`, Фабрика `:4891`, мастерская и SnarkBridge не останавливались и не перезапускались. Живые конфиги/данные, GPU, внешние отправки и платные провайдеры не использовались.

## Проверки

- `corepack pnpm exec vitest run test/launcher-race.test.ts` — PASS, 1 файл, 3/3 теста.
- `corepack pnpm exec tsc --noEmit -p tsconfig.json` — PASS.
- `node --test scripts/launcher-control.test.mjs` — PASS, 9/9.
- `node --test scripts/windowless-launch.test.mjs` — PASS, 3/3.
- `git diff --check` — PASS; только предупреждения Git о LF→CRLF.
- Полный `corepack pnpm exec vitest run` — 95/104 файлов и 555/579 тестов зелёные; 9 файлов, 24 теста красные. `test/launcher-race.test.ts` зелёный. Красные — средовые/соседние проверки: отсутствует `AUTH_HASH_SECRET` в cloud-mode, локальный endpoint/model identity не совпадает с текущим registry, timeout `prompt-library`, а `atomic-tools` получил timeout и `EBUSY` на своей временной папке.
- После полного Vitest проверены тестовые остатки: два `node` и связанный `cmd/conhost`, запущенные в 17:29:16–17 именно этим прогоном, погашены; повторная проверка PID ничего не нашла. Живые процессы не затрагивались.

## Что не сделано / что ждёт владельца

- Live restart не проверялся — это запрещено правилами владельца; доказательство ограничено изолированными тестами.
- Коммит не создан: `git add` не смог создать `Y:/Процесс/SnarkRoute/.git/worktrees/sr-restart/index.lock` (`Permission denied`). Правки оставлены незакоммиченными в текущем worktree; push/merge не выполнялись.
- Полный Vitest не зелёный по причинам выше; исправления соседних пунктов и настройку секретов/локальных endpoint-тестов не выполнял.

## Строка для «Решения»

`влить? Да — влить изменения snarkroute-restart-race после проверки владельцем; нет — оставить ветку без live-проверки и без исправления несвязанных средовых падений полного Vitest.`
