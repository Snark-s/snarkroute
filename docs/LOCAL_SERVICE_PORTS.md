# Локальные порты и маршрутизация SnarkRoute

**Единственный источник адресов:** `service-endpoints.json` в корне SnarkRoute.
Любое изменение порта делается сначала здесь; дублирующиеся порты считаются
ошибкой конфигурации. Указанный host всегда `127.0.0.1`, извне локальные
API недоступны. Реестр не содержит ключей или учётных данных.

| Сервис | Порт | Назначение |
| --- | ---: | --- |
| SnarkRoute API | 4317 | Единственный маршрут Mixar к LLM / провайдерам |
| Mixar sidecar | 18880 | Задачи, планировщик, агентный WebSocket |
| Mixar Blender bridge | 18767 | Команды к открытой сцене Blender |
| Mixar watchdog | 18881 | Локальный TCP-singleton |
| SnarkBridge MCP | 8767 | Инструменты ChatGPT |
| SnarkBridge tunnel | 8080 | Защищённый канал ChatGPT, **не LLM** |
| Bonsai inference | 8081 | Локальный провайдер за SnarkRoute |
| Ollama inference | 11434 | Локальный провайдер за SnarkRoute |

## Цепочка

`Mixar UI → Mixar sidecar (18880) → SnarkRoute (4317) → [провайдер]`

Модельный вызов (планировщик, ремонт, проверка, prompt refinement)
никогда не обходит SnarkRoute. SnarkRoute выбирает провайдера,
проверяет доступность, учитывает стоимость и регистрирует отказы.

При отсутствии работающих моделей sidecar возвращает **ошибку SnarkRoute**,
а не пытается напрямую обратиться на порт Ollama/Bonsai.
Отдельный мост `18767` предназначен только для команд Blender, это не LLM.

## Переезд на другой ПК

Python-sidecar читает путь в порядке приоритета:
`SNARKROUTE_PORT_REGISTRY`, затем
`SNARKROUTE_HOME/service-endpoints.json`, затем текущий путь
`Y:\Процесс\SnarkRoute\service-endpoints.json`. Можно использовать
другие буквы дисков, указав переменную окружения. Node SnarkRoute по умолчанию
читает реестр из корня своего проекта (либо через
`SNARKROUTE_PORT_REGISTRY`).

Перед запуском проверяй реестр и занятость портов, не меняй их в
`config.json` Mixar и не включай старый `ensure_local_llm`.
Параметры `LOCAL_LLM_BASE_URL` и
`LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON` относятся **только** к SnarkRoute.
Допускаются зарегистрированные локальные inference-порты (8081, 11434);
старый 8080 запрещён.

## Контроль

- `python I:\SnarkBridge\workspace\smoke_snarkroute_port_authority.py`
- `python I:\SnarkBridge\workspace\verify_live_router_stack.py`
- `node .../tsx/dist/cli.mjs scripts/smoke-service-endpoints.ts`
- `tsc --noEmit -p apps/server/tsconfig.json`

При изменении адресов перезапусти SnarkRoute API и Mixar sidecar.
Действующий SnarkBridge (MCP и туннель) не трогай без необходимости.

## SnarkBridge в «Мастерской»

Карточка SnarkBridge и чип в деке локальных процессов управляются сервером
SnarkRoute (`apps/server/src/services/snarkbridge-local.ts`), а не через MCP
самого SnarkBridge:

- Start / Stop — `POST /api/system/local-runtimes/snarkbridge/start|stop`
  (общий Local Runtime Supervisor); Restart, проверки и журнал —
  `POST /api/system/snarkbridge/restart`, `GET /api/system/snarkbridge`,
  `GET /api/system/snarkbridge/logs`.
- Запуск — штатный `I:\SnarkBridge\START_SNARKBRIDGE.ps1 -ResetBackoff`
  (MCP `server.py` и туннель через `CONNECT_SNARKBRIDGE.ps1 -Quiet`, ключ —
  из `.tunnel-key.dpapi`), в отдельном скрытом PowerShell, переживающем
  перезапуск SnarkRoute.
- Остановка и проверка владельцев — `scripts/snarkbridge-control.ps1` по
  правилам `snark_services.ps1` (путь exe + командная строка); чужие и
  непроверяемые процессы (например, туннель, запущенный с правами
  администратора) не останавливаются.
- Stop пишет `I:\SnarkBridge\.owner-stopped.json`; пока он есть,
  `START_SNARKBRIDGE.ps1` (задачи «SnarkBridge Local MCP» и «SnarkBridge
  Watchdog») ничего не запускает. Start/Restart в «Мастерской» удаляют маркер.
- «Работает» — только если `/health` (identity `snarkbridge-mcp`) и `/mcp`
  отвечают, а туннель успешно опрашивал OpenAI не позже 120 с назад.
  «Доступ из ChatGPT» = Connected лишь после доставленного ответа на запрос
  ChatGPT; иначе Unknown.
