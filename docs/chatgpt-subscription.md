# ChatGPT Subscription (Codex CLI)

Подписка владельца на ChatGPT (Plus/Pro) работает как обычный провайдер SnarkRoute
`chatgpt_subscription`, рядом с `claude_subscription`. Транспорт — официальный Codex CLI
(`codex exec`) на этом компьютере со входом через ChatGPT. Это не API-ключ OpenAI и не
платный API, а те же лимиты плана, что и в приложении Codex.

```text
клиент → SnarkRoute 4317 (ai.text / Бужа / Jabberwock / /api/chatgpt-subscription/chat)
       → services/chatgpt-subscription.ts (квота, история, диалоги, очередь)
       → services/codex-cli.ts → codex exec --json → план ChatGPT
```

Общие куски с Claude Subscription лежат в `services/subscription-common.ts` (очередь,
порядок ходов диалога, JSON-хранилища), `providers/subscription-text.ts` (сборка промпта)
и `routes/subscription-common.ts` (только loopback).

## Подключение

1. CLI: `codex --version` (проверено на `codex-cli 0.149.0`). Путь ищется как в
   `services/codex-desktop.ts` (`CODEX_CLI_EXECUTABLE`, затем `where codex`), можно задать
   `SNARKROUTE_CODEX_COMMAND`.
2. Вход: `codex login` (ChatGPT в браузере). `POST /api/chatgpt-subscription/login` открывает
   то же окно. `codex login status` должен ответить `Logged in using ChatGPT`.
3. Флаг: `CHATGPT_SUBSCRIPTION_ENABLED=1` в `.env`, потом перезапуск SnarkRoute.
4. Проверка: `tsx apps/server/scripts/chatgpt-subscription-smoke.ts`.

Необязательные переменные: `CHATGPT_SUBSCRIPTION_MODELS=default,gpt-…` (вместо живого
списка), `CHATGPT_SUBSCRIPTION_MAX_CONCURRENCY=2`, `CHATGPT_SUBSCRIPTION_ALLOW_CREDITS=1`.
Последнюю ставить только с явного решения владельца, подробности в разделе «Квота».

## Учётные данные и защита от платного API

- Codex сам хранит и обновляет вход в `CODEX_HOME` (по умолчанию `~/.codex`). SnarkRoute
  его `auth.json` не читает и не копирует. Флаг `--ignore-user-config` отключает только
  `config.toml` владельца, вход остаётся тем же. Технорадар (`runCodexRadarCli`) пока
  копирует access-токен в отдельный `CODEX_HOME`. Здесь это не повторено: без копии нет
  второго владельца refresh-токена и нет рассинхрона при его ротации.
- Из окружения процесса удаляются все `OPENAI_*`, `AZURE_OPENAI*` и `CODEX_*`, кроме
  `CODEX_HOME` (`CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, переменные хост-сессии Codex).
- Каждый вызов идёт с `-c forced_login_method="chatgpt"` и `-c model_provider="openai"`.
- `codex login status` проверяется перед ходом (кэш 60 с). Вход по API-ключу или токену
  отклоняется (`NOT_SUBSCRIPTION`), ход не запускается.
- Стоимость: CLI не сообщает ни цену, ни «API-эквивалент», поэтому SnarkRoute её не
  придумывает. В учёте `actualCost = 0`, `pricingSource = "subscription"`.

## Вызов

Режим простой генерации текста. Флаги проверены по `codex exec --help`, а не по документации:

- `--json --ignore-user-config --ignore-rules --skip-git-repo-check`, `-s read-only`, `-C <workspace>`;
- `-c model_instructions_file=<файл>`: системная инструкция заменяет базовые инструкции
  агента Codex и передаётся файлом, вне командной строки;
- `-c mcp_servers={}`, `-c web_search="disabled"`, `-c project_doc_max_bytes=0` (без AGENTS.md),
  `-c skills.include_instructions=false`, `-c history.persistence="none"`, `-c approval_policy="never"`;
- инструменты выключены через `-c features.<имя>=false` (`shell_tool`, `unified_exec`, `apps`,
  `plugins`, `browser_use`, `computer_use`, `image_generation`, `multi_agent`, `view_image`,
  `hooks` и др.). `--disable` не используется: он падает на имени, которого нет в новой
  версии CLI, а `-c features.*` такие имена молча пропускает;
- если в потоке всё же появится действие (`command_execution`, `file_change`, `mcp_tool_call`…),
  процесс убивается, ход падает с `CLI_ERROR`.

Промпт подаётся в stdin. Рабочая папка пустая и отдельная:
`apps/server/data/chatgpt-subscription/workspace`.

| Возможность | Как | Есть в CLI |
| --- | --- | --- |
| Модель | `-m <slug>`; id в реестре `subscriptions/openai/<slug>`; `subscriptions/openai/default` — без `-m` | да |
| Список моделей | живой: `codex debug models`, `visibility: "list"`, кэш 10 мин | да |
| Диалоги | первый ход сохраняет сессию Codex, дальше `codex exec resume <id>`; смена модели внутри диалога через `-m` | да |
| Отмена | AbortSignal убивает процесс; таймаут 10 мин | да |
| Одноразовый вызов | сессия сохраняется, чтобы прочитать квоту, затем `codex delete --force <id>` | да |
| Стриминг | `exec --json` отдаёт только итоговое сообщение, дельт текста нет | **нет** |
| Tool calling, temperature, top_p, max_tokens, картинки на входе | — | не используется |

Версии моделей в коде не зафиксированы. Список приходит из CLI. `default` берёт модель
CLI по умолчанию, фактический slug (например `gpt-5.6-sol`) виден в `status` и в
`metadata.resolvedModel` каталога. Если подписка отвечает `model_not_found`, модель
помечается недоступной на 6 часов. При смене модели в диалоге Codex пишет
предупреждение. Оно уходит в логи узла и в SSE-событие `warning`, ошибкой не считается.

Codex кладёт фактическую модель и снимок лимитов в собственный файл сессии
(`CODEX_HOME/sessions/ГГГГ/ММ/ДД/rollout-…-<id>.jsonl`). Из него читаются только
`turn_context.model` и `token_count.rate_limits`, учётных данных там нет. Диалоги SnarkRoute
видны в списке сессий Codex (источник `exec`, папка workspace SnarkRoute). При
`DELETE /conversations/:id` сессия удаляется и там.

## HTTP (только loopback)

- `GET /api/chatgpt-subscription/status[?refresh=1]` — CLI, вход, план (`planType`), квота, модели, история за 24 ч, `capabilities`.
- `POST /api/chatgpt-subscription/login` — открыть официальный `codex login`.
- `POST /api/chatgpt-subscription/chat` `{model, prompt, system?, conversationId?: "new"|id, stream?: true}`.
  При `stream: true` приходят SSE-события `session`, `warning`, `rate_limit`, `done`, `error`. Событий
  `delta` нет, потому что CLI их не выдаёт.
- `GET|DELETE /api/chatgpt-subscription/conversations[/:id]`.
- `POST|DELETE /api/chatgpt-subscription/quota/simulate-exhausted` — имитация лимита для смоука.

## Где доступны модели

- В общем каталоге (`/api/models/v1`, `/api/models/for-node/ai.text`) и в ручном выборе узла `ai.text`.
- В автоматической маршрутизации на уровне `subscription` вместе с Claude. Порядок:
  local → subscription → free → paid (paid только с `allowPaid`). Отключить уровень:
  `routingPolicy.subscriptionModels = "exclude"`.
- В Буже (`/api/system/buzha/models`) и в агентных ролях Jabberwock.
- Через MCP `models_list`, если владелец открыл модели в Мастерской.

## Квота

- После каждого хода из файла сессии берётся `rate_limits`: `plan_type`, окно 5 ч (`primary`),
  недельное окно (`secondary`), `used_percent`, `resets_at`, `credits`. Последний снимок показывает
  `status.quota.lastRateLimit`.
- Окно использовано на 100 %, `rate_limit_reached_type` или `spend_control_reached` значат, что подписка
  считается исчерпанной до самого позднего сброса из исчерпанных окон. Без времени сброса пауза 15 минут.
  До сброса модели в каталоге `unavailable`, вызов даёт `SUBSCRIPTION_LIMIT_REACHED` (HTTP 429).
- Ответ CLI «usage limit / 429» тоже даёт `SUBSCRIPTION_LIMIT_REACHED` со временем сброса из снимка.
- Платные кредиты ChatGPT: если лимит плана исчерпан, Codex может списывать кредиты. SnarkRoute
  останавливает вызовы уже на 100 %, поэтому кредиты не тратятся. Ход, который сам пересёк лимит,
  остановить нельзя: CLI заранее не сообщает, пойдёт ли ход за счёт кредитов. Исключение —
  `CHATGPT_SUBSCRIPTION_ALLOW_CREDITS=1`.
- Автоматическая маршрутизация при ошибке подписки первым повтором исключает только упавшую модель,
  так что может ответить вторая подписка. Вторым повтором выходит из уровня подписок, платный API
  без разрешения не используется. Ручной выбор не подменяется, клиент получает ошибку.
- История последних 500 запросов лежит в `apps/server/data/chatgpt-subscription/history.json`.

## Границы

- В каталоге заявлен только `text.generate`. `response_format: json_object` выполняется только
  инструкцией, без гарантии схемы. Стриминга нет, см. таблицу. Если нужны дельты, придётся
  переходить на `codex app-server` (экспериментальный JSON-RPC). Это отдельная задача.
- Model Gateway jobs (`/api/model-gateway/jobs`) работают только с медиа. Текст идёт через раннер
  `ai.text` (`/api/routes/run`) и `/api/chatgpt-subscription/chat`.
- Личное использование: маршруты отвечают только loopback-клиентам и регистрируются только в
  `APP_MODE=local`. Нет аккаунтов, нет раздачи доступа другим людям, нет перепродажи. Codex CLI с
  входом ChatGPT — официальный способ работать в рамках плана, но давать лимиты своего плана
  другим людям нельзя. Поэтому адаптер не превращать в сервис для других. При сомнениях
  сверяться с актуальными условиями OpenAI и документацией Codex.

## Живая проверка (2026-10-28)

`chatgpt-subscription-smoke.ts` на плане Plus (codex-cli 0.149.0) прошёл все пункты. Сервер
SnarkRoute этой ветки поднимался в процессе на временном loopback-порту, в окружение
специально подложен фальшивый `OPENAI_API_KEY`:

- вход `chatgpt`;
- маршрут `ai.text` → `default` = `gpt-5.6-sol` ответил `PONG` с учтённой стоимостью 0;
- стрим-эндпоинт отдал `session, rate_limit, done` без дельт;
- диалог `gpt-5.6-luna` → `gpt-5.6-sol` вспомнил кодовое слово, второй диалог его не знал;
- план `plus`, окно 5 ч занято на 3 %;
- отмена записана как `cancelled`;
- имитация лимита дала 429, а автомаршрутизация ушла на `claude_subscription`
  (`claude-haiku-4-5`) со стоимостью 0; после сброса снова выбрана ChatGPT-подписка.

Ход занимает 3–6 с. Модели аккаунта: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
