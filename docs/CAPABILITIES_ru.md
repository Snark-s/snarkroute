# Возможности BoojumRoute Lab

## Краткое резюме

BoojumRoute Lab — экспериментальная графовая среда для сборки AI-пайплайнов из нод. Здесь можно соединять модели, промпты, изображения, текстовые преобразования и внешние сервисы в маршруты, которые можно запускать, сохранять и расширять собственными нодами.

Текущая версия — локально-ориентированный visual workflow editor плюс backend исполнения для route-документов в стиле Open Route Protocol. Основные рабочие возможности: React Flow canvas, типизированные соединения нод, импорт/экспорт маршрутов, сохранение/восстановление через localStorage, исполнение bundled-нод, управление установленными пакетами нод, библиотека промптов, локальная работа с ассетами и execution metadata.

## Пользовательские возможности Studio

| Возможность | Что можно делать | Статус | Где в UI |
|---|---|---:|---|
| Canvas editing | Добавлять, двигать, выбирать и удалять ноды/связи | implemented | Main canvas |
| Node palette | Добавлять ноды кликом или drag-and-drop | implemented | Левая панель |
| Node categories | Просматривать сгруппированные категории нод | partially implemented | Левая панель |
| Typed connections | Соединять совместимые output/input handles | implemented | Canvas handles |
| Add compatible node | Потянуть связь из output и выбрать совместимую ноду | implemented | Floating menu |
| Save / load | Сохранять и загружать текущий проект локально | implemented | Toolbar |
| Local restore | Восстанавливать сохранённый маршрут при запуске | implemented | Startup |
| Import / export | Импортировать и экспортировать `.orp`, `.route`, JSON/YAML | implemented | Toolbar, drag/drop |
| Installed nodes | Устанавливать, включать, отключать и удалять пакеты нод | implemented | Settings |
| Missing-node placeholders | Сохранять unknown/disabled/uninstalled ноды как placeholders | implemented | Node card warning |
| Compound / subroute | Сворачивать часть графа во внутренний subroute | implemented | Toolbar/context menu |
| Logs / results / preview | Смотреть логи, JSON-результаты и превью | implemented | Bottom panel, nodes |
| Route execution | Валидировать и запускать route целиком или отдельные ноды | implemented | Top bar/node controls |

## Route / graph model

- Поддерживаются `.orp`, `.orp.json`, `.orp.yaml`, `.route`, `.route.json`, `.route.yaml`, plain JSON/YAML.
- Ноды имеют `id`, `type`, `title`, `params`, `inputs`, `outputs`, `compound`, `capability`, `subroute`, `nodePackage`, `ui`.
- Связи имеют `from`, `to`, `fromPort`, `toPort` и optional `id`.
- Typed ports работают в Studio и manifests.
- Validation покрывает schema, duplicate IDs, missing endpoints, отдельные встроенные типы и node-package availability.
- Compound nodes используют `type: "compound.subroute"` и embedded `subroute`.

## Node system

- Built-in bundled nodes: text/file/image/video inputs, capability nodes, prompt library, image preview, template transform, debug log, HTTP request, local Stable Diffusion, text/file outputs.
- Provider bundled nodes доступны server-side через adapters.
- Installed local nodes хранятся в `data/installed-nodes`.
- Node manifests используют формат `snarkroute.node` с permissions, executor, ports, params и metadata.
- Node library import поддерживает `snarkroute.nodeLibrary`.
- Plugin nodes вызывают executor module через `runNode(context)`.
- Declarative HTTP nodes работают через `declarative.http`; generic `declarative` пока требует уточнения.

## Execution

- Execution order строится через topological sort и cycle detection.
- Template interpolation поддерживает выражения вида `{{nodeId.output.path}}`.
- Compound node execution запускает embedded subroute.
- Logs и results собираются по run и node.
- Provenance и cost usage сохраняются как metadata.
- Output files и generated/downloaded images пишутся в run folders.

## Ограничения

- В палитре пока нет полноценного поиска.
- Dirty indicator не вынесен как постоянный явный статус.
- Compound port editing остаётся rough.
- Server-side project storage ещё не заменил browser localStorage.
- Перед важными демо визуальное состояние Studio лучше проверять в браузере.
