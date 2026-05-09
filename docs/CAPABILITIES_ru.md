# Инвентаризация возможностей SnarkRoute

## 1. Краткое резюме

SnarkRoute сейчас представляет собой локально-ориентированный визуальный редактор маршрутов/workflow плюс backend исполнения для документов в стиле Open Route Protocol. Основные рабочие возможности: редактирование canvas на React Flow, типизированные соединения нод, импорт/экспорт маршрутов, сохранение/восстановление через localStorage, исполнение bundled-нод, управление установленными пакетами нод, поддержка библиотеки промптов/ресурсов, локальная работа с ассетами и исполнение с логами, результатами и economics metadata.

Уверенность: высокая. Основано на `apps/studio`, `apps/server`, `packages/protocol`, `packages/nodes`, `packages/executor` и focused tests.

## 2. Пользовательские возможности Studio

| Возможность | Что пользователь может делать | Статус | UI | Связанные файлы | Примечания / ограничения |
|---|---|---:|---|---|---|
| Редактирование canvas | Добавлять, двигать, выбирать ноды и связи на canvas React Flow | implemented | Основной canvas | `apps/studio/src/main.tsx` | Использует `@xyflow/react`; позиции сериализуются в `ui.x/y`. |
| Палитра нод | Добавлять ноды кликом или перетаскиванием | implemented | Левая боковая панель | `apps/studio/src/main.tsx` | Каталог приходит из `/api/nodes`; есть fallback hardcoded library. |
| Поиск / категории нод | Просматривать сгруппированные категории нод | partially implemented | Левая боковая панель | `apps/studio/src/main.tsx` | Категории реализованы; реального поля поиска не найдено. |
| Соединения нод | Соединять типизированные output handles с типизированными input handles | implemented | Handles на canvas | `apps/studio/src/main.tsx` | Совместимость допускает точное совпадение kind, `data`, а также text/json crossover. |
| Добавление совместимой ноды через drag из output | Потянуть связь из source output на пустой canvas и выбрать совместимую ноду | implemented | Плавающее меню “Add connected node” | `apps/studio/src/main.tsx` | Запускается только из source handles. |
| Удаление нод | Удалять выбранную/контекстную ноду и связанные edges | implemented | Toolbar, клавиатура, context menu | `apps/studio/src/main.tsx` | Delete/Backspace отключены внутри текстовых полей. |
| Контекстное меню | Действия по правому клику на node/pane/selection | implemented | Canvas context menu | `apps/studio/src/main.tsx` | Включает delete, collapse, back, clear, subroute actions. |
| Save / load | Сохранять/загружать текущий проект локально | implemented | Левая toolbar | `apps/studio/src/main.tsx` | Использует browser `localStorage`, не server-side project files. |
| Восстановление из localStorage | Восстанавливает сохранённый проект при запуске приложения | implemented | Startup | `apps/studio/src/main.tsx` | Если saved route не парсится, fallback к пустому route. |
| Import / export route | Импорт route-файла; export `.orp` text download; drop route на canvas | implemented | Toolbar и drag/drop | `apps/studio/src/main.tsx`, `packages/protocol/src/index.ts` | Поддерживает `.orp`, `.orp.json`, `.orp.yaml`, `.route.*`, plain JSON/YAML; UI также мапит `.opt` в `.orp` при drop. |
| Управление установленными нодами | Установка из file/path/URL/library; enable/disable/read README/uninstall | implemented | Правая Settings panel | `apps/studio/src/main.tsx`, `apps/studio/src/nodePackageImport.ts`, server node APIs | Bundled nodes нельзя uninstall. |
| Missing-node placeholders | Сохранять unknown/disabled/uninstalled node instances и предупреждать | implemented | Warning на node card | `apps/studio/src/main.tsx`, `packages/nodes/src/package-system.ts` | Validation сообщает missing node type. |
| Compound / Subroute nodes | Сворачивать выбранные ноды в `compound.subroute` | implemented | Toolbar/context menu | `apps/studio/src/main.tsx`, `packages/executor/src/index.ts` | Port exposure выбирается через browser prompts. |
| Open Subroute / Back | Входить во внутренности compound и возвращаться к parent | implemented | Node buttons/top bar/context menu | `apps/studio/src/main.tsx` | Back сохраняет отредактированный subroute в parent. |
| Collapse / Uncollapse | Сворачивать выбранный graph; разворачивать compound обратно в parent canvas | implemented | Toolbar/context menu/node buttons | `apps/studio/src/main.tsx` | Переподключает mapped external edges. |
| Clear canvas | Удалять все nodes/edges после confirmation | implemented | Toolbar/context menu | `apps/studio/src/main.tsx` | Сбрасывает outputs/run result/selection. |
| Logs / results / preview | Показывать logs/output JSON; inline node results; image modal/download | implemented | Bottom panel и nodes | `apps/studio/src/main.tsx` | Bottom panel стартует свернутой. |
| Run / execution UI | Validate, run whole route, run node with deps, run node only | implemented | Top bar/node controls | `apps/studio/src/main.tsx`, server `/api/routes/run` | Node-only требует готовых upstream outputs или immediate input nodes. |
| Dirty state / saved snapshot | Отслеживает snapshot и предупреждает перед открытием examples | partially implemented | Open Example flow | `apps/studio/src/main.tsx` | Явного постоянного dirty indicator не найдено. |

Уверенность: средне-высокая. Реализованные handlers были просмотрены, но визуальный запуск Studio не проводился.

## 3. Возможности route / graph model

- Поддержка формата route: implemented. JSON/YAML import/export для `.orp`, `.orp.json`, `.orp.yaml`, `.route`, `.route.json`, `.route.yaml`, плюс plain JSON/YAML. Protocol code находится в `packages/protocol/src/index.ts`.
- Nodes: implemented с полями `id`, `type`, `title`, `params`, `inputs`, `outputs`, `compound`, `capability`, `subroute`, `nodePackage`, `ui`.
- Edges: implemented с `from`, `to`, `fromPort`, `toPort`, optional `id`.
- Inputs/outputs/params: implemented как JSON-like поля route и manifest fields.
- Typed ports: implemented в Studio и manifests. Runtime читает ports по output field/path.
- Validation: implemented для schema, duplicate IDs, missing edge endpoints, `library.prompt`, `http.request`, local Stable Diffusion, economics splits. Backend добавляет prompt-library и node-type validation.
- Missing node handling: protocol допускает unknown node types; backend validation сообщает missing installed node; Studio показывает placeholder warning.
- Compound representation: `type: "compound.subroute"` с mappings `compound.inputs/outputs` и embedded `subroute`.
- Subroute representation: nested full `RouteDoc`.
- Exposed compound ports: implemented через mapping `{ id, kind, nodeId, port }`.
- Internal node IDs: сохраняются внутри subroute; execution prefix-ит internal results как `compoundId/internalNodeId`.
- Serialization/deserialization: implemented через protocol export/load и Studio `flowToRoute`/`routeToFlow`.

Уверенность: высокая.

## 4. Возможности node system

- Built-in bundled nodes: implemented. Включает text/file/image/video inputs, capability nodes, prompt library, image preview, template transform, debug log, HTTP request, local Stable Diffusion, text/file outputs.
- Provider bundled nodes: implemented server-side для Replicate model, Replicate Clarity Upscaler, Gemini LLM, Gemini Nano Banana 2.
- Installed local nodes: implemented в `data/installed-nodes`, хотя текущий `data/installed-nodes` выглядит пустым.
- Node manifests: implemented как `snarkroute.node` JSON с permissions, executor, ports, params, metadata.
- Node library import: implemented для URL preview/install `snarkroute.nodeLibrary`.
- Node URL import: implemented для manifest JSON или `.snarknode` URL.
- Local path/file import: implemented для dev folder, manifest path, `.snarknode`, `.node.json`, JSON file.
- Permissions metadata: implemented и отображается; env allowlisted для plugin nodes; shell permission refused at runtime.
- Executor types: `builtin`, `plugin`, `declarative.http` запускаются. Plain `declarative` валидируется, но runner registration не найден, поэтому, вероятно, non-executable.
- Declarative nodes: partially implemented. `declarative.http` работает; generic `declarative` unclear/likely not runnable.
- Plugin nodes: implemented через import executor module и вызов `runNode(context)`.
- Example/scaffold nodes: присутствуют в `examples/custom-nodes`.

Уверенность: высокая для package system, средняя для generic `declarative`.

## 5. Возможности execution

- Execution order: implemented через topological sort и cycle detection.
- Template interpolation: implemented для `{{nodeId.output.path}}`; dependencies должны иметь edges.
- Compound node execution: implemented через исполнение embedded subroute с synthetic input nodes.
- Internal subroute execution: implemented; internal logs/results folded into parent run with prefixes.
- Logs: implemented per run и per node.
- Results: implemented как `nodeResults`, сохраняются в `run.json`.
- Errors: implemented; failures возвращают run status `failed` с node error details.
- Provenance: implemented на run/node/provider level.
- Cost usage: metadata/accounting only; provider usage tracked, payment always false.
- Asset/output handling: output directory per run; generated/downloaded images и output files записываются в run folders.
- Known executor limitations: нет arbitrary shell; missing runner fails; generic `declarative`, вероятно, not executable; external providers require tokens/local services; template references require explicit edges.

Уверенность: высокая.

## 6. Возможности backend / API

Implemented endpoints в `apps/server/src/index.ts` включают:

- Health: `GET /api/health`
- Settings: `GET /api/settings`, `POST /api/settings/replicate-token`, `POST /api/settings/gemini-token`
- Node catalog/install: `GET /api/nodes`, `GET /api/node-packages/installed`, preview/install file/path/url/library, enable/disable, delete, README
- Routes: `GET /api/routes/examples`, `GET /api/routes/examples/:filename`, `GET /api/routes/saved`, `POST /api/routes/validate`, `POST /api/routes/run`
- Runs/ledger: `GET /api/runs/:runId`, `GET /api/ledger/runs`, `GET /api/ledger/runs/:runId`, `GET /api/ledger/summary`
- Prompt library: list, prompt read, refresh
- Assets: metadata, preview, browse, import
- Provider helpers: Replicate schema, local Stable Diffusion models

Known limitations: saved routes API lists asset route files, но Studio save/load использует localStorage; local file browse Windows-only; external model calls зависят от secrets и network/local backends.

Уверенность: высокая.

## 7. Карта файлов и пакетов

| Path | Responsibility | Important files | Notes |
|---|---|---|---|
| `apps/studio` | React Studio UI | `src/main.tsx`, `src/nodePackageImport.ts`, `src/security-ui.ts`, `src/styles.css` | Actual app folder is `apps/studio`, not `apps/web`. |
| `apps/server` | Fastify API server | `src/index.ts`, tests | Actual API folder is `apps/server`, not `apps/api`. |
| `packages/protocol` | Route schema/import/export/validation | `src/index.ts`, `test/protocol.test.ts` | Equivalent to route-core protocol layer. |
| `packages/executor` | Graph execution engine | `src/index.ts`, `test/executor.test.ts` | Topological execution, templates, compound, ledger. |
| `packages/nodes` | Built-ins, node package system, prompt/resources, local assets | `src/index.ts`, `src/package-system.ts`, `test/nodes.test.ts` | Central node system. |
| `packages/adapters` | Provider adapters | `gemini/src/index.ts`, `replicate/src/index.ts` | External API runners. |
| `packages/storage` | Run storage | `src/index.ts` | Minimal local run persistence. |
| `examples` | Example routes and node packages | `routes/*`, `custom-nodes/*` | Good demo material. |
| `data/installed-nodes` | Installed node packages | currently empty | Runtime install target. |
| `docs` | Protocol/project docs | `custom-nodes.md`, `node-package-format.md`, `declarative-http-executor.md` | Useful but implementation was prioritized. |
| `.codex` | Codex skill metadata | `.codex/skills/snarkroute-node-builder/SKILL.md` | Repo-local agent aid, not product runtime. |

Уверенность: высокая.

## 8. Готовность к демо

| Area | Ready for demo? | Why | Risks |
|---|---|---|---|
| Basic canvas editing | Да | Add/move/connect/delete implemented | Visual polish not verified live. |
| Running a simple route | Да | Built-in execution и tests cover simple routes | External providers need tokens. |
| Importing a node | Да | File/path/URL/library install paths exist | Plugin code trust/security caveat. |
| Installed node management | Да | Enable/disable/README/uninstall implemented | Empty installed dir by default. |
| Compound/subroute editing | В основном | Collapse/open/back/uncollapse implemented | Prompt-based port UI is rough. |
| Save/load/reload | Да | localStorage save/restore implemented | Not server-backed; dirty UI partial. |
| Error handling | В основном | Validation/run errors surface in logs/results | Some UI flows may only log errors. |
| Visual clarity | Неясно | CSS/UI exists | Not verified in browser during this inventory. |

## 9. Пробелы и следующая работа

Demo blockers:

- Нет очевидных блокеров для локального basic route demo.
- Provider demos требуют valid Replicate/Gemini tokens или local Stable Diffusion endpoint.

Important but not blocking:

- Добавить реальный поиск по node palette.
- Добавить видимый dirty-state indicator.
- Уточнить или убрать unsupported generic `declarative` executor type.
- Улучшить compound port editing вместо browser prompts.
- Решить, должен ли Studio показывать server saved routes.

Polish:

- Более хорошая inline validation before run.
- Более понятное guided missing-node recovery.
- Улучшить installed node success/failure UX.
- Расширить demo examples around no-token local routes.

Architectural risks:

- Plugin nodes execute imported JS/TS modules, хотя shell refused и env allowlisted.
- Route files сохраняют portability, но installed executors external to route documents.
- Nested subroutes increase complexity вокруг IDs, port mappings и execution diagnostics.

## 10. Предлагаемые demo scripts

### 1. Basic route demo

Steps: Open Studio, add `Text Input`, `Template Transform` or `Debug Log`, connect text output, validate, run.

Expected visible result: logs show node starts/completions; outputs panel shows run JSON/text.

What this demonstrates: canvas editing, typed connections, validation, execution, logs/results.

### 2. Installed node demo

Steps: Use Settings -> Node Packages, install `examples/custom-nodes/http-json-declarative.snarknode` or a manifest/path, add node to canvas, run or validate, then disable/uninstall.

Expected visible result: node appears in palette/installed list; uninstall preserves existing route node as missing placeholder.

What this demonstrates: portable node packages, permissions metadata, installed node lifecycle, missing-node behavior.

### 3. Compound/subroute demo

Steps: Build a small two-node chain, select both, click Collapse, open subroute, edit/move internal nodes, Back, run parent route, then Uncollapse.

Expected visible result: compound node replaces selection; internal route opens; parent receives updated subroute; uncollapse restores nodes.

What this demonstrates: compound representation, subroute editing, exposed ports, nested execution.

## 11. Confidence Notes

- Executive summary: high.
- Studio capabilities: medium-high; source is clear, but browser was not launched to visually confirm.
- Route/model: high; protocol and tests are explicit.
- Node system: high, except generic `declarative` executor is medium/low because validation exists but runner registration was not found.
- Execution: high; executor tests cover order, templates, compound, errors, ledger.
- Backend/API: high; endpoints are centralized in one server file and covered by focused tests.
- Demo readiness: medium; implementation looks demoable, but visual clarity and live provider readiness need a browser/server check next.
