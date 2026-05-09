# Библиотека промптов

Библиотека промптов в SnarkRoute - это локальная папка с Markdown-файлами. Каждый файл хранит один переиспользуемый промпт, который можно выбрать в ноде `Prompt Library`.

## Где лежат файлы

Папка по умолчанию:

```text
data/prompt-library/
```

Файлы промптов ищутся по шаблону:

```text
data/prompt-library/**/*.prompt.md
```

Чтобы добавить новый промпт, создай файл:

```text
data/prompt-library/<category>/<prompt-id>.prompt.md
```

## Формат файла

```markdown
---
id: retro-futuristic-editor-joke
title: Retro-futuristic editor joke
category: image-generation
description: Demo prompt for SnarkRoute
tags:
  - demo
  - easter-egg
---

A retro-futuristic easter egg illustration about building our own visual AI editor with blackjack and courtesans, playful but not explicit, cinematic, detailed, humorous.
```

Обязательные поля:

- `id`
- `title`
- `category`
- непустой текст промпта после frontmatter

Опциональные поля:

- `description`
- `kind`
- `tags`

Ссылка на промпт собирается так:

```text
<category>/<id>
```

Для примера выше:

```text
image-generation/retro-futuristic-editor-joke
```

Имя папки не обязано совпадать с `category`, но лучше держать их одинаковыми: так библиотеку проще читать глазами.

## Как обновить в Studio

После добавления или правки `.prompt.md` файла нажми `Refresh Prompt Library` в ноде `Prompt Library`.

Можно сделать то же самое через API:

```text
POST /api/prompt-library/refresh
```

Перезапуск сервера не нужен: refresh заново сканирует файлы библиотеки.

## Как это хранится в маршруте

Текущий MVP использует такие параметры:

```json
{
  "id": "prompt1",
  "type": "library.prompt",
  "params": {
    "category": "image-generation",
    "promptId": "retro-futuristic-editor-joke",
    "mode": "linked"
  }
}
```

Для локальных черновиков и экспериментов с переносимостью поддерживается embedded-режим:

```json
{
  "id": "prompt1",
  "type": "library.prompt",
  "params": {
    "category": "custom",
    "promptId": "draft",
    "mode": "embedded",
    "embeddedText": "Local prompt text."
  }
}
```

Нода не должна хранить прямые пути к файлам или прямые URL промптов.

## Что возвращает нода

`library.prompt` возвращает текст:

```json
{
  "text": "<resolved prompt text>"
}
```

В будущей AssetRef-архитектуре это должно переехать в `params.assetRef`, чтобы один и тот же механизм мог резолвить локальные файлы, embedded assets, bundle и remote manifests.

---

This document is licensed under CC BY-SA 4.0.
