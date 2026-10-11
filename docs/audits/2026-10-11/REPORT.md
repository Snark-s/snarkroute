# Аудит SnarkRoute / Jabberwock Mixar / PersonaCore / SnarkBridge

Дата: 11 октября 2026. Изменения выполнены в ветках `codex/stack-stabilization-20261011`. Исходное состояние, включая прежние незакоммиченные правки, сохранено отдельно. Пользовательские сцены не открывались и не сохранялись. Платные генерации и аренда GPU не выполнялись.

## Дефекты и проверки

| Дефект / первопричина | Риск | Исправление | Проверка |
|---|---|---|---|
| Несколько списков портов; Bonsai использовал порт туннеля 8080 | Высокий | Один `service-endpoints.json`; Bonsai 8081; переопределения обязаны совпадать с реестром | Node/Python registry tests; действующие health |
| Открытый TCP/404/ответ другого сервера считался готовностью | Высокий | HTTP 200, отсутствие redirect, identity/API version; для inference — contract и фактический список моделей | D; Bonsai/Ollama/upscale/H3 tests |
| Auto и библиотечные обходы предпочитали Polza/платный маршрут | Высокий | Local First → доступный подтверждённый бесплатный → явное разрешение на платный; неизвестная цена считается платной | Реальная локальная генерация A; отдельный реальный API B; библиотечные контракты |
| Manual/fallback мог изменить смысл выбора и разрешения | Высокий | Manual закреплён; политика проверяется сервером; библиотека не выполняет частный Polza fallback в local | Routing policy и library tests |
| Установленный executor мог обойти политику или выполнить plugin JS | Критический | Запрет plugin executor; декларативные model HTTP операции проходят общий policy check | Installed runner tests; формат ORP/snarknode сохранён |
| H3/Fal/Vast/World Labs и внешние decision backends обходили согласие | Высокий | Одноразовое literal `allowPaid:true`; проверка до запуска/очереди; UI спрашивает согласие, внешний worker включён | Paid media, H3 queue/runtime, decision tests; реальных расходов нет |
| API библиотеки терял routingPolicy и errorDetails | Высокий | Политика передаётся во все пять генерационных обработчиков; код, источник и retryable сохраняются | 44 library tests, включая два новых API сценария |
| 402 провайдера превращался в ошибку собственных кредитов Mixar | Высокий | В local vendor subscription path отключён; ошибка содержит origin/provider/status; исчерпанный провайдер временно исключается | C: mocked upstream HTTP 402 + реальный класс HTTPClient в Mixar |
| Mixar vendor REST/auth/WebSocket/updates обходили локальный маршрут | Высокий | Ранние transport guards; собственный local marker; vendor credentials не читаются/не обновляются; прямые inference порты запрещены | Настоящий portable Mixar: REST, requests, urllib/WebSocket guards; credential spy; локальная генерация через sidecar |
| Защищённый RPC клиент читал только plaintext token | Высокий | Общий read-only DPAPI reader для сервера и клиентов; отсутствие ключа блокирует запрос | Настоящий `local_tool_agent._post` с разрешённым ключом владельца |
| Blender RPC допускал браузерные запросы и небезопасную обработку | Критический | Token, loopback Host, Origin/fetch restrictions, JSON limit, очередь main thread, fencing таймаута, ограниченный export root | G/H: реальный Blender HTTP RPC; внешний Origin/Host отклонены; сцена неизменна |
| План/выполнение/проверка смешивались; успешное исполнение считалось достижением цели | Высокий | AST contract, отдельная read-only verification, только boolean `passed:true`, task phases, отказ оптимистичному reporter | E/F: неправильный код отклонён; реальный Cube x=1 против цели x=2 не verified |
| Нет сериализации GPU admission / двойные старты | Высокий | Общий admission lock, VRAM checks, identity preflight, ownership, ограниченный supervisor | I: конкурентные admissions и отказы; idle health snapshot; ресурсная гонка без тяжёлого запуска |
| Python venv PID не совпадал с владельцем socket | Средний | Допустим непосредственный дочерний interpreter проверенного venv launcher, с проверкой аргумента сервера | Настоящий перезапуск MCP и identity API v1 |
| Persona health требовал bearer, launcher объявлял живой сервер неготовым | Средний | Публичная только identity health; данные по-прежнему требуют bearer; Host/Origin сохранены | Настоящий /health, реальные HTTP auth tests, 159 Persona tests |
| Медленный Persona startup повторно запускал дочерние процессы | Средний | Хранение собственного pending child; повторные вызовы не создают дубликат; bounded retries | Node regression |
| CEP file-origin конфликтовал с новым HTTP boundary | Средний | Native Node loopback transport в CEP; одноразовый pairing; null Origin разрешён только аутентифицированному AE WebSocket | Server pairing tests, CEP tests и production build |
| Локальные пути содержали mojibake/зависели от прежней буквы диска | Высокий | UTF-8 registry, относительные пути и environment roots; restore перезаписывает registry и pointer | K: relocation tests; L: отдельное восстановление |
| ZIP restore допускал traversal, drive/ADS и выход через symlink | Высокий | Проверка всех members и resolved destination containment, запрет duplicate names | 18 recovery tests; symlink test требует права ОС и был пропущен |

## Конечная схема

```mermaid
flowchart LR
  Mixar[Portable Jabberwock Mixar] --> Sidecar[Mixar Local sidecar]
  Persona[PersonaCore agent] --> Gateway[SnarkRoute Model Gateway]
  Studio[Studio / CEP] --> Gateway
  Sidecar --> Gateway
  Registry[service-endpoints.json] -. ports / paths / identity .-> Gateway
  Registry -.-> Sidecar
  Registry -.-> Persona
  Gateway --> Policy[Capability + availability + pricing + permission]
  Policy --> Local[Ollama / Bonsai / local media workers]
  Policy --> Free[Confirmed free provider]
  Policy --> Paid[Explicitly approved paid provider]
  Gateway --> Resources[Serialized GPU admission / owned process lifecycle]
  Sidecar --> Planner[Plan / Validate / Execute / Verify]
  Planner --> RPC[Authenticated loopback RPC / main-thread queue]
  RPC --> Scene[Blender scene]
  Recovery[SnarkDeploy ZIP + Git bundles + SHA256] -. restore configured roots .-> Registry
```

Реестр определяет адреса. Готовность определяется контрактом соответствующего сервиса. Наличие локального MCP не доказывает доступность подключённого плагина в ChatGPT; это отдельная внешняя сторона соединения.

## Состав изменений

Полный список и SHA256 до/после: `changes.json`; внешние компоненты: `external-changes.json`; коммиты: `commits.json`. Прежние пользовательские правки в файлах, которые затронул аудит, отделены checkpoint-коммитами. Остальные прежние изменения оставлены в рабочем дереве. Видео и очередь H3 не добавлены в коммиты аудита.

Защищённая локальная сборка находится в каталоге `mixar_runtime` реестра. Она содержит копию исходного Mixar executable с тем же SHA256 и обновлёнными Python модулями. Исходная установка `C:\Program Files\Mixar` не изменена. Загрузка Python overlay через startup оказалась слишком поздней; экспериментальная накладка удалена, рабочее решение применяет политику до vendor imports.

## Проверки и реальные пределы

Автоматические A–D находятся в `apps/server/test/model-routing-integration.test.ts`; они используют контролируемый transport и не обращаются к платным провайдерам. Реальная A: Ollama `llama3:latest`, ответ `OK`, cost 0; JSON сохранён в evidence. Реальная B: отдельный API, два пустых inference порта, пустые provider credentials, `PAID_PERMISSION_REQUIRED`.

E/F/G/H выполнены настоящим portable Mixar/Blender на заводской сцене. Отдельная G/H проверка использовала настоящий sidecar client и DPAPI ключ владельца, созданный только после его явного разрешения. Значение ключа не выводится и в recovery bundle не включается.

J выполнен частично: два новых процесса Blender, настоящий `bpy` theme, постоянные startup assets, hashes неизменны, заводская сцена восстановлена. Отображение всех кнопок, плавающего агента, рамок и масштабирование при разных DPI **не проверены**: native computer APIs недоступны. Полная native C++ сборка также не подтверждена: установленный MSVC 14.41 старше требуемого toolset. Янтарная тема и оригинальный Jabberwock asset существовали до аудита; их сохранение проверено, их создание не приписывается аудиту.

I проверяет admission и concurrency контролируемыми snapshot/launch зависимостями. Одновременно тяжёлые GPU модели специально не запускались. K проверяет перенесённые корни и реестр. Результат полного L вынесен в `recovery-verification.json`.

AST проверка ограничивает допустимый план, но не является полноценной изоляцией Python. Локальный RPC доступен процессам владельца ключа; это доверенные процессы пользователя. Установленные bridge/startup расширения не объявляются вредоносными: их собственные функции сцены, journal, memory sync, cloud tunnel и updater являются штатной функциональностью, требующей явной границы доверия.

## Запуск и восстановление

Практическая инструкция: `RUNBOOK.md`. Воспроизводимые проверки: `scripts/check-local-stack.ps1 -Blender -LiveUnavailable`; тесты TypeScript/Vitest запускаются для изменённых пакетов. Полные логи находятся в локальном `.tmp/audit-20261011`, проверяемые краткие результаты — в evidence.

## Сознательно сохранено

- Переносимый ORP и форматы `.snarknode`, economics/provenance, cloud product behavior. Новая политика действует в локальном режиме; payment permission не превращается в постоянный ключ внутри route или queue.
- Пользовательские сцены, видео, текущие проекты, секреты Mixar/Persona/провайдеров, исходная установка Mixar. Единственный новый production credential — явно разрешённый ключ RPC.
- FreeToken установлен как прежний компонент, но inference service выключен в реестре и не нужен локальному gateway. Legacy direct launch сообщает о необходимой миграции.
- WSL distro/user defaults и большие model weights остаются конфигурацией конкретной машины. Архив хранит инвентарь тяжёлых моделей, а не переносит все веса или GPU драйверы.
- Cloud tunnel не заменён. Запуск и перезапуск MCP отделены от изменения внешней регистрации ChatGPT connector.
- Штатный cloud memory sync PersonaCore сохранён, в local выключен без явного opt-in; пользовательские cloud credentials не менялись.
- Проверка ZIP ищет запрещённые пути и известные текстовые признаки секретов; это не доказательство отсутствия любой произвольной строки секрета внутри всей бинарной Git истории.
