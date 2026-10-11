# Запуск и восстановление локального стека

## Текущая машина

Из корня SnarkRoute:

```powershell
node scripts/audit-local-services.mjs
node scripts/start-launcher.mjs
& ./scripts/start-mixar.ps1
& ./scripts/check-local-stack.ps1 -Blender -LiveUnavailable
```

`start-mixar.ps1` запускает защищённый portable runtime из `service-endpoints.json`. Старый ярлык `C:\Program Files\Mixar\mixar.exe` запускает первоначальную установку и не является проверенным локальным runtime.

Для MCP используйте `START_SNARKBRIDGE.ps1` / `RESTART_BRIDGE_SERVER.ps1` в каталоге `snarkbridge` реестра. Sidecar: Python `server.py` в `mixar_local`; Persona: существующий `scripts/start_extension_bridge.py` в `personacore`. Не запускайте второй экземпляр на занятом порту. Проверяйте identity и API version, а не только TCP.

MCP работает с согласованным `stateless_http=True`: каждый HTTP request независим от прежней session ID. Bridge использует фиксированные scoped tools без необходимого состояния MCP-сессии. Loopback bind, Host/Origin validation, лимит 1MiB и файловые ограничения сохранены. Локальная проверка: задайте `SNARKROUTE_PORT_REGISTRY` на действующий `service-endpoints.json`, затем выполните `<snarkbridge>/.venv/Scripts/python.exe tests/stack/snarkbridge_mcp_restart_probe.py --live` из SnarkRoute. Это проверяет прежнюю session ID, новую SDK-сессию и отказы запрещённых запросов. Дополнительно проверяйте настоящий подключённый tool. После согласованной настройки и ремонта скрытого запуска он вернул status=ok/version=0.4.1. Tunnel readiness учитывает свежесть control-plane poll (≤120s), а не только наличие прежнего успешного poll. Штатный `RESTART_SNARKBRIDGE_TUNNEL.ps1` ждёт первый 30s long-poll в пределах 100 проверок с паузой 500ms плюс длительность health-команды. Автоматический запуск использует `CONNECT_SNARKBRIDGE.ps1 -Quiet`, явный native security module текущего PowerShell и Hidden/NonInteractive; ключ должен уже существовать. Для первой выдачи ключа используйте обычный интерактивный CONNECT. На новой машине заново установите logon/watchdog tasks через исправленные установщики: они включают Hidden/NonInteractive и передают проверенный путь реестра, не полагаясь на environment/profile pointer задачи. Путь передаётся через безопасно quoted UTF-16 EncodedCommand для кириллицы; ключей в task arguments нет. Права остаются Limited. Из нового SnarkRoute задайте `SNARKROUTE_PORT_REGISTRY` на новый реестр, затем запустите установщики в новом SnarkBridge. Проверка построения действия без регистрации задач: `tests/stack/scheduled_startup_probe.ps1 -BridgeRoot <new-snarkbridge>`. Учётные данные в source archive не входят.

Порты: API 4317, sidecar 18880, Blender RPC 18767, MCP 8767, Persona 8766, cloud tunnel 8080, Bonsai 8081, Ollama 11434, upscale 8091. Остальные адреса и контракты указаны в реестре. Отсутствующая idle inference модель не означает поломку UI/API.

Local First использует доступные локальные модели. Неизвестная цена не считается бесплатной. Manual не даёт разрешения на расходы. Пример разрешения только для конкретного вызова API: `routingPolicy: { allowPaid: true }`. Секреты и permission не следует добавлять в переносимую route как постоянную настройку.

Vendor cloud features Mixar, авторизация подписки, автоматическое обновление и прямые запросы к inference daemon в защищённом local runtime отключены. Неподдерживаемая cloud операция возвращает `LOCAL_CLOUD_DISABLED`. Исходный cloud runtime сохранён; его запуск — отдельный выбор пользователя.

## Новая машина / другая буква диска

Скопируйте recovery ZIP и его `.sha256`. Получите `snarkdeploy.py` из архива/этого репозитория. Требуются Git, Python и Node. Укажите **свои** абсолютные корни до восстановления:

```powershell
$env:SNARK_PROCESS_ROOT = 'D:/Work'
$env:SNARK_APPS_ROOT = 'D:/Apps'
$env:PERSONA_HOME = 'D:/PersonaCore'
$env:SNARKBRIDGE_ROOT = 'D:/SnarkBridge'
$env:SNARK_AI_ROOT = 'D:/AI'
$env:SNARK_BONSAI = 'D:/AI/Bonsai-demo'
$env:SNARK_MIXAR_PROFILE = "$env:APPDATA/Mixar/Mixar/5.2"
python -X utf8 deploy/snarkdeploy/snarkdeploy.py verify 'D:/Backup/snark-recovery-<timestamp>.zip'
python -X utf8 deploy/snarkdeploy/snarkdeploy.py restore 'D:/Backup/snark-recovery-<timestamp>.zip' --dry-run
python -X utf8 deploy/snarkdeploy/snarkdeploy.py restore 'D:/Backup/snark-recovery-<timestamp>.zip'
```

Используйте пустые целевые каталоги. Restore применяет вложенные Git bundles без необходимости получить текущие исходники из сети, затем восстанавливает source patch/untracked files и обновляет абсолютные пути registry/pointer. Зависимости Node/Python не входят в source ZIP: установите их из закреплённых manifest/lock files. Portable Mixar executable и его встроенный Python входят в отдельный application компонент.

Для воспроизводимой изолированной проверки всего архива выберите **новый, ещё не существующий** каталог. Скрипт направляет все компоненты, APPDATA и LOCALAPPDATA внутрь него и проверяет отсутствие переноса ключей:

```powershell
python -X utf8 tests/stack/restore_archive_probe.py 'D:/Backup/snark-recovery-<timestamp>.zip' --target 'D:/RestoreTest/stack'
```

Git bundle сохраняет историю основного Mixar source repo. Полная история Blender upstream submodule в архив не загружается; для новой native C++ сборки отдельно получите этот submodule и установите поддерживаемый MSVC toolset. Это не требуется для запуска включённого portable runtime.

В восстановленном SnarkRoute установите закреплённые зависимости и соберите API:

```powershell
corepack pnpm --filter snarkroute --filter '@snarkroute/server...' install --frozen-lockfile --ignore-scripts
corepack pnpm -r --filter '@snarkroute/server...' build
node tests/stack/live_unavailable_route.mjs
```

`--offline` можно добавить, если локальный pnpm store полный. В проверке этого архива он был неполным; недостающие packages загружены по lockfile с integrity verification. Для PersonaCore из его нового каталога создайте virtual environment и установите `requirements.txt`; для SnarkBridge отдельно установите его Python requirements в `.venv`. Точные prerequisites/install commands перечислены в `deploy/snarkdeploy/manifest.json`. Не включайте cloud registration/credentials автоматически. Для рабочих SQLite данных и disposable test fixtures используйте быстрый локальный диск; backup drive во время массовой установки может не уложиться в короткий тестовый HTTP timeout.

Полное восстановление этого архива проверено на X; результат и source commits — `recovery-verification.json`. Factory запуск восстановленного runtime воспроизводится `evidence/restore-factory.ps1 -Target '<новый каталог полного восстановления>'` после `restore_archive_probe.py`.

На новой машине восстановите provider `.env`, Persona extension token и tunnel registration вручную из вашего vault. DPAPI ключ привязан к Windows пользователю/машине и не экспортируется. Создание нового RPC ключа — отдельное действие владельца:

```powershell
& ./scripts/provision-mixar-rpc-token.ps1
```

Скрипт не заменяет существующий credential. `-Rotate` применяется только при отдельном разрешении владельца. Не печатайте ключ и не включайте его в Git или архив.

Проверьте новый `service-endpoints.json`, особенно `mixar_runtime`, `mixar_startup`, `personacore`, `snarkbridge`, `bonsai_home`. Для другой WSL distro/user задайте соответствующие H3/YuE настройки. Модели и GPU/CUDA зависимости восстанавливаются отдельно по инвентарю; model inventory не заменяет веса.

Запустите health audit и factory tests. До открытия реальной сцены выполните проверки планирования/верификации на заводской сцене. Проверка GUI/DPI остаётся отдельной ручной приёмкой.

## Создание нового архива

```powershell
python -X utf8 deploy/snarkdeploy/snarkdeploy.py snapshot --output 'X:/SnarkBackups'
python -X utf8 deploy/snarkdeploy/snarkdeploy.py verify 'X:/SnarkBackups/snark-recovery-<timestamp>.zip'
```

Эти команды создают локальный архив и проверку. Не используйте сторонние backup wrappers, если не намерены включить их cloud upload/retention поведение. В ходе этого аудита старые backup archives не удалялись.
