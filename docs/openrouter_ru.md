# OpenRouter в SnarkRoute

OpenRouter - основной remote provider для SnarkRoute. MVP-путь намеренно простой:

```text
SnarkRoute -> OpenRouter -> supported remote models
```

Прямые адаптеры Gemini и Replicate остаются для Advanced/Direct mode и для моделей или форматов ответа, которые пока не проверены через OpenRouter. Локальные модели через OpenRouter не запускаются.

## Как получить API key

1. Откройте Settings в SnarkRoute.
2. В разделе **AI Providers** нажмите **Get API Key**.
3. Создайте или скопируйте OpenRouter API key.
4. Вставьте ключ в **OpenRouter API Key**.
5. Нажмите **Save**, затем **Test Connection**.

Если пользователь не залогинен, OpenRouter может перенаправить на sign-in.

## Credits

Используйте **Add Credits** в Settings или откройте:

```text
https://openrouter.ai/settings/credits
```

SnarkRoute в этом MVP не продаёт кредиты, не управляет кошельками и не запускает marketplace payments.

## Catalog моделей

Кнопка **Refresh Model Catalog** вызывает:

```text
GET https://openrouter.ai/api/v1/models
```

Локальный cache хранится здесь:

```text
data/cache/openrouter-models.json
```

Код читает поля defensive: отсутствие optional fields не должно ломать Settings или запуск.

## Default Model

Default model сохраняется в локальный `.env` как `OPENROUTER_DEFAULT_MODEL`. API key сохраняется там же как `OPENROUTER_API_KEY`.

Не коммитьте API keys в git.

## OpenRouter и Direct mode

Обычные task-ноды показывают простой выбор модели, а provider mode спрятан в **Advanced**:

- **Auto** использует OpenRouter, если mapping проверен.
- **Auto** откатывается на существующий Direct provider, если OpenRouter mapping неизвестен.
- **OpenRouter** принудительно использует OpenRouter и понятно падает, если model id не mapped.
- **Direct** использует старый прямой adapter, если он настроен.

Direct mode нужен, когда модель, media output или provider feature ещё не проверены через OpenRouter.

## Local models

Локальные модели остаются локальными. Они не требуют OpenRouter API key и не должны маршрутизироваться через remote provider.

## Как добавить mapping

Mappings лежат здесь:

```text
data/model-registry/openrouter-mappings.json
```

Добавляйте `openrouterModel` только после проверки slug в cached catalog или официальной документации. Не угадывайте slugs.

## Provider links

Ссылки для Settings лежат здесь:

```text
data/provider-links.json
```

Backend отдаёт их через:

```text
GET /api/providers/links
```

UI должен брать URL оттуда, а не хардкодить provider links в компоненте.

## Безопасность ключей

`/api/settings` не возвращает OpenRouter key, только masked value. Ключи не должны попадать в route params, route export, logs или client-side errors.

Ignored secret paths:

```text
.env
.env.local
data/secrets/*
data/settings/secrets.json
```
