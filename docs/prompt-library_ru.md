# Библиотека промптов BoojumRoute Lab

Библиотека промптов в BoojumRoute Lab — это локальная папка с Markdown-файлами. Каждый файл хранит один переиспользуемый промпт, который можно выбрать в ноде `Prompt Library` и подключить к AI-пайплайну как обычный узел графа.

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
description: Demo prompt for BoojumRoute Lab
tags:
  - demo
  - easter-egg
---

A retro-futuristic easter egg illustration about building our own visual AI editor, playful but not explicit, cinematic, detailed, humorous.
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

То же самое можно сделать через API:

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

Нода не должна хранить прямые пути к файлам или прямые URL промптов. В route сохраняется ссылка на библиотечный промпт или embedded-текст.

## Что возвращает нода

`library.prompt` возвращает текст:

```json
{
  "text": "<resolved prompt text>"
}
```

Так промпты можно соединять с моделями, текстовыми преобразованиями, генераторами изображений и другими нодами BoojumRoute Lab.

---

This document is licensed under CC BY-SA 4.0.
