# BoojumRoute Lab: кратко для нового пользователя

## Что это такое

BoojumRoute Lab — экспериментальная графовая среда для сборки AI-пайплайнов из Blocks / BlockNodes. Здесь можно соединять модели, промпты, изображения, текстовые преобразования и внешние сервисы в маршруты, которые можно запускать, сохранять и расширять собственными block packages.

Идея простая: вместо набора разрозненных API-вызовов, скриптов и ручных шагов пользователь собирает процесс на canvas. Blocks соединяются проводами, данные проходят от входов к преобразованиям, генераторам, превью и выходам, а результат можно проверить по логам и результатам выполнения.

Node — umbrella term в общей модели SnarkRoute. В этом руководстве по BoojumRoute традиционные route nodes являются executable BlockNodes, а не творческими ArtifactNodes из SnarkRoute.

BoojumRoute Lab локально-ориентирован: маршруты можно собирать, импортировать, экспортировать, сохранять в браузере, запускать через backend и расширять установленными пакетами нод.

## Что можно делать сейчас

### Визуальный canvas

Можно добавлять blocks, двигать их по canvas, соединять output одного block с input другого, удалять blocks и связи, запускать маршрут и смотреть logs, results и preview.

### Палитра нод

В Studio есть палитра nodes/blocks с категориями. Blocks можно добавлять кликом или перетаскиванием. В BoojumRoute Lab есть bundled blocks, которые идут вместе с проектом, и installed block packages, которые можно добавить отдельно.

### Быстрое добавление совместимой ноды

Можно потянуть связь из output-порта и отпустить на пустом месте canvas. Studio покажет меню совместимых нод, а выбранная нода сразу добавится и подключится.

### Сохранение и восстановление

Studio сохраняет текущую схему в browser localStorage и восстанавливает её при перезапуске. Это локальное хранение в браузере, а не полноценное серверное хранилище проектов.

### Импорт и экспорт маршрутов

Маршруты можно импортировать, экспортировать или перетащить на canvas. Поддерживаются `.orp`, `.orp.json`, `.orp.yaml`, `.route`, `.route.json`, `.route.yaml`, а также plain JSON/YAML.

### Установленные ноды

Studio умеет устанавливать node packages из файла, локального path, URL или node library. Установленными blocks можно управлять: включать, отключать, читать README и удалять. Bundled blocks удалить нельзя.

### Missing-node placeholders

Если маршрут использует block/node, который не установлен или отключен, Studio не ломает маршрут. Она сохраняет экземпляр как placeholder и показывает warning. Это важно для переносимости route-файлов между машинами.

### Compound / Subroute nodes

Выбранные blocks можно свернуть в compound node с внутренним subroute. Внутренний граф можно открыть, отредактировать, выполнить и при необходимости развернуть обратно.

### Исполнение маршрутов

Execution engine определяет порядок выполнения по graph dependencies, находит циклы, выполняет blocks, делает template interpolation вида `{{nodeId.output.path}}`, запускает compound/subroute, собирает logs, results, provenance и cost usage metadata.

### Backend/API

Backend предоставляет API для health check, settings и API tokens, каталога нод, установки node packages, route validation, route execution, runs/ledger, prompt library, assets и provider helpers.

## Из чего состоит проект

| Папка | За что отвечает |
|---|---|
| `apps/studio` | UI Studio, canvas, palette, context menu, save/load |
| `apps/server` | Fastify backend/API |
| `packages/protocol` | Формат route, import/export, validation |
| `packages/executor` | Execution engine |
| `packages/nodes` | Built-in blocks и package system |
| `packages/adapters` | Адаптеры внешних провайдеров |
| `examples` | Примеры routes и custom nodes |
| `docs` | Документация |

## Хорошие первые демо

### Простой маршрут

Добавить `Text Input`, соединить его с `Template Transform` или `Debug Log`, запустить route и посмотреть logs/results. Это показывает базовый workflow: canvas, typed connections, run, logs, save/restore.

### Installed node

Открыть Settings -> Node Packages, установить custom node из `examples/custom-nodes`, добавить его на canvas и запустить или провалидировать route. Затем отключить или удалить установленный block и показать missing-node placeholder.

### Compound/subroute

Собрать маленькую цепочку из двух-трёх blocks, выделить часть графа, свернуть в compound node, открыть subroute, изменить внутренний граф, вернуться назад, запустить parent route и развернуть compound обратно.

## Что пока слабое или требует доработки

- В палитре есть категории, но нет полноценного поиска.
- Dirty state реализован частично: нет очевидного постоянного индикатора.
- Compound port editing пока rough и использует browser prompts.
- Generic `declarative` executor выглядит не до конца поддержанным; `declarative.http` работает.
- Provider demos требуют токены внешних провайдеров или локальный Stable Diffusion endpoint.
- Studio save/load пока использует localStorage, а не серверное хранилище проектов.
- Visual clarity нужно проверять вживую в браузере перед демо.

## Главная мысль

BoojumRoute Lab — это не просто нодовый редактор. Это лаборатория маршрутов, где AI-инструменты, локальные процессы, внешние API, промпты, ассеты и пользовательские blocks можно соединять в понятные визуальные пайплайны.
