# Claude Subscription (Claude Code CLI)

Подписка владельца на Claude (Pro/Max) работает как обычный провайдер SnarkRoute
`claude_subscription`. Транспорт — официальный Claude Code CLI (`claude -p`) на этом
компьютере. Отличие от Anthropic API сохраняется: это не API-ключ и не платный
API, а та же подписка, что и в интерактивном Claude Code, со своими лимитами.

```text
клиент → SnarkRoute 4317 (ai.text / Бужа / Jabberwock / /api/claude-subscription/chat)
       → services/claude-subscription.ts (квота, история, диалоги, очередь)
       → services/claude-code-cli.ts → claude -p --output-format stream-json → подписка
```

## Подключение

1. CLI: `claude --version`. Если CLI нет, его ставит официальный установщик:
   `irm https://claude.ai/install.ps1 | iex`. `GET /api/claude-subscription/status`
   сам подсказывает установку.
2. Вход: `claude auth login --claudeai`. Можно нажать
   `POST /api/claude-subscription/login`, и откроется окно официального входа.
   Учётными данными управляет сам Claude Code. SnarkRoute не читает и не копирует
   OAuth-токены, к недокументированным эндпоинтам не ходит.
3. Флаг: `CLAUDE_SUBSCRIPTION_ENABLED=1` в `.env`, потом перезапуск SnarkRoute.
4. Проверка: `tsx apps/server/scripts/claude-subscription-smoke.ts`.

Необязательные переменные: `CLAUDE_SUBSCRIPTION_MODELS=opus,sonnet,haiku` (алиасы CLI),
`CLAUDE_SUBSCRIPTION_MAX_CONCURRENCY=2`, `SNARKROUTE_CLAUDE_COMMAND` (путь к `claude`),
`CLAUDE_SUBSCRIPTION_ALLOW_EXTRA_USAGE=1`. Последнюю ставить только с явного решения
владельца, подробности в разделе «Квота».

## Защита от платного API

- Из окружения дочернего процесса удаляются все `ANTHROPIC_*` (ключ, base URL,
  токены), `CLAUDE_CODE_*` (в том числе `CLAUDE_CODE_OAUTH_TOKEN` и флаги
  Bedrock/Vertex) и `CLAUDECODE`.
- `claude auth status --json` должен показать вход через claude.ai у first-party
  провайдера. Вход по API-ключу или через Console отклоняется.
- В каждом ходе init-событие CLI сообщает `apiKeySource`. Если там не `none`, процесс
  убивается до запроса к модели (`NOT_SUBSCRIPTION`).
- Расчётная стоимость из CLI (`total_cost_usd`) сохраняется как
  `apiEquivalentCostUsd` для информации. В расходы она не записывается: в учёте стоит
  `actualCost = 0`, `pricingSource = "subscription"`.

## Вызов

Режим простой генерации текста: `--tools ""`, `--strict-mcp-config` без серверов,
`--setting-sources ""` (без хуков, плагинов и CLAUDE.md владельца),
`--disable-slash-commands`, системная инструкция идёт через `--system-prompt-file`,
промпт подаётся в stdin. Рабочая папка пустая и отдельная:
`apps/server/data/claude-subscription/workspace`, поэтому сессии SnarkRoute не
смешиваются с проектами владельца в Claude Code.

| Возможность | Как |
| --- | --- |
| Модель | `--model <alias>`; id в реестре: `subscriptions/anthropic/{opus,sonnet,haiku}` |
| Стриминг | `--output-format stream-json --verbose --include-partial-messages`, наружу как SSE |
| Диалоги | новый: `--session-id <uuid>`, продолжение: `--resume <id>`; один диалог — одна сессия |
| Отмена | AbortSignal убивает процесс; также таймаут 10 мин |
| Одноразовый вызов | `--no-session-persistence` |

Версии моделей в коде не зафиксированы. Алиас CLI всегда указывает на текущую модель
семейства. Фактический id (например `claude-sonnet-5`) берётся из init-события и
виден в `status` и в `metadata.resolvedModel` каталога. Если подписка не даёт
модель, алиас помечается недоступным на 6 часов.

## HTTP (только loopback)

- `GET /api/claude-subscription/status[?refresh=1]` — CLI, вход, тип подписки, квота, модели, история за 24 ч.
- `POST /api/claude-subscription/login` — открыть официальный вход.
- `POST /api/claude-subscription/chat` `{model, prompt, system?, conversationId?: "new"|id, stream?: true}`.
  При `stream: true` приходят SSE-события `session`, `delta`, `rate_limit`, `done`, `error`.
- `GET|DELETE /api/claude-subscription/conversations[/:id]`.
- `POST|DELETE /api/claude-subscription/quota/simulate-exhausted` — имитация лимита для смоука.

## Где доступны модели

- В общем каталоге (`/api/models/v1`, `/api/models/for-node/ai.text`) и в ручном выборе узла `ai.text`.
- В автоматической маршрутизации появился отдельный уровень стоимости `subscription`.
  Порядок: local → subscription → free → paid (paid только с `allowPaid`). Отключить
  уровень для задачи: `routingPolicy.subscriptionModels = "exclude"`.
- В агентных ролях Jabberwock (fixed-модель или auto) и в Буже (`/api/system/buzha/models`).
- Через MCP `models_list`, если владелец открыл модели в Мастерской (System → Models and providers).

## Квота

- Из потока берутся события `rate_limit_event`: статус, тип окна, время сброса.
  Последнее событие показывает `status.quota`.
- Отказ по лимиту даёт `SUBSCRIPTION_LIMIT_REACHED` (HTTP 429) и `resetsAt`, если CLI
  его сообщил, иначе пауза 15 минут. До сброса провайдер в каталоге `unavailable`.
- Автоматическая маршрутизация при такой ошибке сначала исключает только упавшую модель, так что
  может ответить ChatGPT-подписка (`docs/chatgpt-subscription.md`). Второй повтор идёт уже без
  уровня подписок. Ручной выбор не подменяется, клиент получает ошибку.
- Платное дополнительное использование (extra usage) не включается. Если CLI сообщает,
  что ход пошёл бы за счёт extra usage, процесс останавливается и подписка считается
  исчерпанной до сброса. Исключение — `CLAUDE_SUBSCRIPTION_ALLOW_EXTRA_USAGE=1`.
- История последних 500 запросов лежит в `apps/server/data/claude-subscription/history.json`:
  модель, время, токены, статус, вызывающий.

## Границы

- Не поддерживается: tool calling (запрос с `tools` отклоняется), temperature,
  top_p и max_tokens (у CLI их нет, они игнорируются с записью в лог), изображения
  на входе. `response_format: json_object` выполняется только инструкцией, без
  гарантии схемы. Поэтому в каталоге заявлен только `text.generate`.
- Model Gateway jobs (`/api/model-gateway/jobs`) работают только с медиа. Текст идёт
  через раннер `ai.text` (`/api/routes/run`), стриминг — через `/api/claude-subscription/chat`.
- Личное использование: маршруты отвечают только loopback-клиентам и регистрируются
  только в `APP_MODE=local`. Нет аккаунтов, нет раздачи доступа другим людям, нет
  перепродажи. По документации Anthropic подписку можно использовать в оригинальном
  Claude Code, в том числе программно (`claude -p`). Сторонним продуктам Anthropic
  без согласования не разрешает предлагать вход через claude.ai или лимиты подписки
  своим пользователям. Поэтому адаптер не превращать в сервис для других людей. При
  сомнениях сверяться с актуальными Consumer Terms и документацией Claude Code.

## Живая проверка (2026-10-28)

`claude-subscription-smoke.ts` на подписке Pro (Claude Code 2.1.240) прошёл все 8 пунктов:
вход `claude.ai`/first-party/`pro`; маршрут `ai.text` → `claude-haiku-4-5-20251001` ответил `PONG`
с учтённой стоимостью 0; стрим `claude-sonnet-5` пришёл 13 частями; диалог haiku → sonnet
вспомнил кодовое слово, второй диалог его не знал; имитация лимита дала 429, а
автомаршрутизация без локальных моделей не ушла в платный API (бесплатного маршрута не
было — отказ `PAID_PERMISSION_REQUIRED`); после сброса снова выбрана подписка.
Opus на Pro доступен: `opus` → `claude-opus-5`. CLI присылает `rate_limit_event`
(`five_hour`, `resetsAt`, `isUsingOverage`, `overageStatus`); у этой организации
extra usage выключен (`overageDisabledReason: org_level_disabled`).
Ход занимает 3–10 с; «API-эквивалент» шести ходов смоука — $0,012 (не списывается).
