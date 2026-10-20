# Вечерний запуск SnarkRoute — 20.10.2026

Статус: кодовые изменения и тесты готовы, но коммиты и полный PersonaCore-бэкап не завершены из-за ограничений sandbox. Живые службы, GUI, браузеры, GPU-инференс и расписания ChatGPT не запускались и не менялись.

Worktree: `Y:\rebuild\SnarkRoute`
Фактическая ветка: `build/2026-10-20-eve-snarkroute` (ветку не переключал; `rebuild/2026-10-20` в этом worktree не обнаружена).

## Сделано

1. Смотритель:

- В `service-endpoints.json` добавлен `watch`: `always` для обязательных служб, `when_running` для остальных.
- `when_running` на неслушающем порту даёт `off`, не создаёт failure/ticket и не ухудшает общий pulse.
- `always` продолжает считаться сбоем при недоступном health endpoint.
- `launcher` закреплён с `healthPath: "/"`.
- Добавлены тесты на `off`, `always` и реестр.

2. PersonaCore backup:

- В манифесте сохранено включение `{{PERSONA_HOME}}\data`; добавлены исключения `cache`, `caches`, `tmp`, `temp`, `*.lock`.
- В `snarkdeploy` добавлен `snapshot --component personacore`; filtered-run пропускает чужие model/WSL inventories.
- Для sandbox-репозитория с ошибкой Git dubious ownership добавлен безопасный read-only fallback `git-or-copy` в filtered tree copy.
- Архив не завершён: первая попытка остановлена на глобальном `bonsai-models` inventory; вторая дошла до чтения `I:\PersonaCore`, но после более минуты оставила нулевой `.partial` и была остановлена по правилу короткого запуска.
- `restore --dry-run` не выполнялся: полного архива нет. Никаких файлов в `I:\PersonaCore` не записывалось и не удалялось.

3. Радары:

- Добавлены три описания: фестивальный радар, `Immersive Media Brief`, `H3 Max Director Watch`.
- Cron: понедельник 21:00, понедельник 21:00, ежедневно 10:00.
- Все `enabled: false`. Модель по умолчанию — `openrouter/perplexity/sonar-pro`; adapter-путь также поддерживает `polza` и `gemini`.
- При явном включении результат пишется в `data/radars/<id>/<date>.md`, pulse — в `data/radars/<id>/pulse.json`.
- Scheduler подключён к серверу, но при текущем конфиге timer не создаётся. Тесты используют mock model и денег не тратят.

## Проверки

- `npx vitest run src/services/sentinel` — зелёный, 3 файла / 9 тестов.
- `npx vitest run src/services/radar` — зелёный, 1 файл / 6 тестов.
- `npx tsc --noEmit -p tsconfig.json` в `apps/server` — зелёный.
- `python -m unittest deploy/snarkdeploy/test_snarkdeploy.py` — зелёный, 22 теста / 1 ожидаемый skip.
- `graphify update .` — завершён успешно; graph обновлён. Осталось штатное предупреждение о недостающем `tree_sitter_sql`.
- `git diff --check` — без ошибок.

## Git и оставшиеся артефакты

Коммиты не созданы: Git получил `Permission denied` при создании `Y:\Процесс\SnarkRoute\.git\worktrees\SnarkRoute\index.lock`. Изменения оставлены незакоммиченными; lock-файл и чужой основной репозиторий не трогал.

План маленьких коммитов для запуска с правами владельца:

1. `fix(sentinel): ignore stopped optional services`
2. `feat(backup): scope PersonaCore snapshot`
3. `feat(server): add disabled radar scheduler`
4. `docs: add evening run report` — последним.

В `.night-backups` остались два незавершённых `.partial`-файла, созданные попытками backup; ничего не удалялось по правилам запуска.

## Что нужно владельцу

Из доверенной оболочки после проверки объёма `I:\PersonaCore`:

```text
python deploy\snarkdeploy\snarkdeploy.py snapshot --component personacore --output I:\PersonaCore-backups
python deploy\snarkdeploy\snarkdeploy.py restore I:\PersonaCore-backups\snark-recovery-YYYYMMDD-HHMMSS.zip --dry-run
```

Добавить в «Решения»:

- «Включить радары?» — да/нет; включение может вызвать до 9 web-search запросов в неделю (два понедельника + ежедневный H3), стоимость зависит от выбранного провайдера/модели.
- «Разрешить бюджет OpenRouter/Polza/Gemini для радаров?» — да/нет, с лимитом расходов.
- Если целевая ветка действительно `rebuild/2026-10-20`, подтвердить перенос изменений с фактической `build/2026-10-20-eve-snarkroute`.
