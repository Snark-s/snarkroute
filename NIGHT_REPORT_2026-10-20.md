# NIGHT_REPORT_2026-10-20

Запуск 20.10.2026, МСК. Worktree: `Y:\rebuild\SnarkRoute`, ветка
`rebuild/2026-10-20`. Выполнена только Часть 2 брифа — Смотритель внутри
SnarkRoute. Tove, Local Process Manager, живые сервисы и чужие worktree не
изменялись.

## Сделано

- Добавлен `apps/server/src/services/sentinel.ts`:
  - health GET для плиток с timeout 2 s;
  - scheduler с интервалом 5 минут через `start()`;
  - повторная проверка после одного restart;
  - restart разрешён только при явном owner `snarkroute`/`tove` и callback;
    чужой процесс по занятому порту не завершается;
  - второй отказ в скользящем окне 1 час создаёт ticket со статусом
    `застрял`;
  - pulse содержит поля агента, места, расписания, результата и статуса;
  - Bonsai tile проверяет зарегистрированный `/v1/models`.
- Добавлен `apps/server/src/services/sentinel-audit.ts` с read-only git-аудитом,
  сравнением backup coverage и deployment dry-run без записи/секретов.
- Добавлены mock-тесты Смотрителя и аудита.
- В ветке Bonsai registry перенесён `8081 → 8092`. Порт `8091` не трогался:
  он зарегистрирован за `local_upscale`. Модельный endpoint SnarkRoute
  строится через registry, поэтому hardcoded endpoint не добавлялся.
- Подготовлены отчёты:
  - [Bonsai port](docs/sentinel-bonsai-port-2026-10-20.md)
  - [Git audit](docs/sentinel-git-audit-2026-10-20.md)
  - [Backup audit](docs/sentinel-backup-audit-2026-10-20.md)
  - [SnarkBridge 404](docs/sentinel-snarkbridge-404-2026-10-20.md)

## Проверки

Зелёные:

- `node --experimental-strip-types --check apps/server/src/services/sentinel.ts`
- `node --experimental-strip-types --check apps/server/src/services/sentinel-audit.ts`
- такие же syntax checks для двух новых `.test.ts` файлов.
- `python -m json.tool service-endpoints.json` — JSON корректен.
- `git diff --check` — ошибок whitespace нет; Git показал только стандартные
  предупреждения LF→CRLF.
- `graphify update .` — AST-only update, без LLM/GPU: `11,757` nodes,
  `26,896` edges, `534` communities. `graphify-out/` не отслеживается git.

Красные / недоступные:

- `corepack pnpm --filter @snarkroute/server exec vitest run ...` — не запущен:
  в текущем worktree нет `node_modules`; offline install остановился на
  отсутствующем tarball `@babel/helper-string-parser`.
- Попытка использовать существующий Vitest из read-only worktree — `EPERM` на
  его временный config-файл. GPU, серверы и модели не запускались.
- Live `GET http://127.0.0.1:8092/v1/models` намеренно не выполнялся: для
  проверки требовался бы Bonsai/локальный runtime, что запрещено условиями
  запуска.
- Restore dry-run большого архива не выполнялся: архив около 1.49 GB, а
  запасной компьютер и его данные должны оставаться read-only. Наличие dry-run
  подтверждено чтением инструмента и предыдущей evidence; точная текущая
  coverage отмечена как требующая owner verify.

## Тесты 20.10 день

Все прогоны ниже выполнены локально через Vitest/TypeScript; GUI, живые
сервисы, Bonsai/Ollama/H3, CUDA и локальные модели не запускались. Проверки
локального inference используют mock `fetch` и mock callbacks.

- `corepack pnpm --filter @snarkroute/protocol build` — зелёный CPU build.
- `corepack pnpm --filter @snarkroute/model-catalog build` — сначала красный
  из-за отсутствующего dist `@snarkroute/protocol`, после сборки protocol —
  зелёный CPU build.
- `corepack pnpm --filter @snarkroute/server exec vitest run src/services/sentinel.test.ts src/services/sentinel-audit.test.ts test/bonsai-local.test.ts test/local-openai-endpoints.test.ts` — после prerequisite build: **4 файла, 15 тестов зелёные**.
- Расширенная focused-проверка с `test/bonsai2-family-ollama.test.ts` —
  **5 файлов, 20 тестов зелёные; 1 baseline-тест красный**: мок `/models`
  не содержит обязательного `object: "model"`. Два падения старого hardcode
  `8081` устранены заменой на registry-derived `localServiceUrl(...)`.
- `corepack pnpm --filter @snarkroute/server test` — **красный: 97 файлов,
  346 тестов; 51 файл/261 тест зелёный, 46 файлов/85 тестов красные**.
  Красное не вызвано Смотрителем: отсутствуют собранные dist-входы
  `@snarkroute/h3`, `@snarkroute/kie`, `@snarkroute/jev`,
  `@snarkroute/rutronix`; один mock-contract тест Bonsai 2 не согласован с
  текущей проверкой identity; `atomic-tools` имеет timeout 20 s и EBUSY
  временного каталога.
- Проверка baseline `34ab5ea`: `git show` подтверждает старый Bonsai port
  `8081`, а `git diff 34ab5ea..HEAD` показывает, что `local-openai.ts`,
  `atomic-tools` и проблемные package sources в этой ветке не менялись.
  Поэтому исправлены только два port assertions, а baseline-красные не
  замаскированы. Отдельный checkout baseline не создавался: правила запуска
  разрешают работать только в текущем worktree.
- `graphify update .` — зелёный AST-only update без LLM/GPU: `11,870` nodes,
  `26,727` edges, `564` communities; один SQL-файл пропущен из-за отсутствия
  optional `tree_sitter_sql`.

## Что не сделано

- Не изменены live Local Process Manager, `Tove` и прямые endpoint references.
  Предложение владельцу: LPM launch `--port 8081 → 8092`, Tove
  `127.0.0.1:8081/v1 → 127.0.0.1:8092/v1`, предварительно сделать чистую
  проверку и копию `30_BACKUP`. NVIDIA Broadcast на `8081` не трогался.
- Не подключён Google Sheets sink для pulse/ticket: нет owner-доступа и
  токена; в коде оставлены callback-интерфейсы и mock-покрытие. Нужен один
  owner-authorized запрос после согласования API.
- Не выполнялись реальные restart/kill, пятиминутный live цикл и soak; это
  сознательная замена на тестовые callbacks и mock health responses.
- Project Publisher по manifest-пути `Y:\Приложения\Project Publisher` в
  доступном read-only осмотре не найден.

## Git/commit блокировка

До запуска ветка была чистой. Изменения находятся в текущем worktree. Коммит
не выполнен: Git не может создать
`Y:\Процесс\SnarkRoute\.git\worktrees\SnarkRoute\index.lock` и затем
`COMMIT_EDITMSG` (`Permission denied`). Права, общий `.git`, lock-файлы и
чужие worktree не менялись. По явному указанию запуска оба мусорных файла
удалены из текущего worktree; `git rm` не смог застейджить их из-за того же
ACL-блокера. Ветка всё ещё требует staging и двух логических коммитов:
фикса теста порта и удаления артефактов, затем последним — этот отчёт.

## Ждёт владельца

1. Исправить ACL/выполнить коммиты в `rebuild/2026-10-20` маленькими логическими
   шагами, последним — этот отчёт.
2. Скопировать чистый live LPM-конфиг в `30_BACKUP`, применить перенос 8081→8092
   одновременно с Tove references и проверить `/v1/models` HTTP 200.
3. Дать разрешённый Google Sheets доступ для строки `Агенты` либо подтвердить
   конкретный adapter; секрет хранить вне git.
4. Подтвердить внешний SnarkBridge transport: текущий сервер объявляет
   Streamable HTTP `/mcp`, но не legacy `/sse`; 404 на MCP SSE выглядит как
   mismatch пути/транспорта. 429 от 15.10 отдельно требует проверки лимита.
5. После появления зависимостей выполнить новые Vitest, focused server build,
   backup dry-run и owner-authorized Bonsai smoke. Не запускать модели до
   отдельного окна GPU.
