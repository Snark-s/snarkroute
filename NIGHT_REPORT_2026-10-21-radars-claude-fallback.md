# Дневной отчёт 21.10.2026 — radars-claude-fallback

Ветка: `build/2026-10-21-radars-claude-fallback`.

## Сделано

- Дефолтные радары переведены на `polza` с моделью `perplexity/sonar-pro`; существующие env-overrides сохранены.
- Добавлен провайдер `claude-subscription` через локальный CLI: `claude -p ... --output-format json`.
- При ошибке Polza выполняются две логические попытки (основная и один повтор), после чего запускается Claude fallback.
- OAuth-файл читается только непосредственно перед вызовом; значение передаётся дочернему процессу только как `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_API_KEY` из дочернего окружения удаляется. Токен не добавляется в аргументы, логи или ошибки; текст ответа дополнительно редактирует совпадения токена.
- Для CLI разрешён `WebSearch`; если CLI сообщает о неподдержанном инструменте/флаге, выполняется вариант без поиска, а отчёт начинается явной пометкой.
- В Markdown и `pulse.json` записываются `provider`, `model`, `fallback`, причина; в pulse добавлен накопительный `fallbackRuns`.
- Добавлены локальные Vitest-моки для Polza 402, таймаута, пустого ответа, успешного Polza и fake child process без запуска живого CLI.

## Проверки

- `git diff --check` — зелёный.
- `corepack pnpm --filter @snarkroute/server exec tsc --noEmit` — не выполнен: в worktree нет локального `tsc`/`node_modules`.
- `npx --no-install vitest run apps/server/src/services/radar.test.ts apps/server/src/services/radar-config.test.ts` — не выполнен: `npx` попытался получить `vitest` из registry и получил `EPERM`; живые тесты не стартовали.
- Живые Polza/Claude, порты `4890/4891`, GPU и живые данные не трогались.

## Что не сделано

- Тесты и TypeScript-проверка требуют установленного toolchain; без него результат реализации остаётся гипотезой до проверки владельцем/сборочным окружением.
- Коммит не создан: sandbox отказал в записи общего индекса `Y:/Процесс/SnarkRoute/.git/worktrees/sr-radar-fallback/index.lock` (`Permission denied`). Изменения оставлены в текущем worktree; три исходных файла остались staged после неудачной попытки коммита, отчёт добавлен отдельно.

Живой `.env` и путь к реальному токену не изменялись и не читались в ходе работы; путь конфигируется через `SNARKROUTE_CLAUDE_OAUTH_TOKEN_PATH` или `CLAUDE_OAUTH_TOKEN_PATH`, по умолчанию — `Y:\Приложения\Tove\data\secrets\claude_oauth_token.txt`.

Строка для «Решения»: `влить? — проверить radar-тесты и tsc в окружении с зависимостями; затем закоммитить текущие staged/unstaged изменения в build/2026-10-21-radars-claude-fallback.`
