# Что сделано

Локальный YuE2 оформлен как один loopback-сервис с Web UI и API на `http://127.0.0.1:7862`. Сервис использует установленный `YuE2Pipeline`, существующий venv и GPU в `Ubuntu-24.04`; pipeline сохраняется между генерациями. Добавлены standalone BAT-лаунчеры, карточка в «Мастерской», действия Persona/Claude bridge, новый золотой фирменный знак и анимированный favicon во время загрузки и генерации.

# Архитектура

```text
Web UI ───────────────┐
Мастерская ──────────┼─> YuE2 Local Service ─> YuE2Pipeline ─> ~/YuE/outputs/<run>/
Persona / Claude ────┘          ^
                                │
start_yue2.bat ─> PowerShell ─> WSL launcher
```

WSL, пользователь, путь, Python, порт и URL определены в одном файле `config/yue2.local.json`. Мастерская и Persona используют один и тот же backend и не создают отдельные pipeline.

# Созданные файлы

SnarkRoute:

- `config/yue2.local.json`
- `integrations/yue2/service.py`
- `integrations/yue2/index.html`
- `integrations/yue2/start.sh`
- `integrations/yue2/requirements.txt`
- `integrations/yue2/yue2-logo.png`
- `integrations/yue2/yue2-icon.png`
- `integrations/yue2/favicon.png`
- `apps/server/src/services/yue2-local.ts`
- `apps/server/test/yue2-local.test.ts`
- `apps/snarkroute/public/yue2-icon.png`
- `start-yue2.ps1`, `stop-yue2.ps1`
- `start_yue2.bat`, `stop_yue2.bat`
- `artifacts/yue2-webui.png`, `artifacts/yue2-workshop.png`

PersonaCore:

- `app/extension_bridge/yue2.py`
- `functions/yue2.md`
- `tests/test_extension_yue2.py`
- `extension/public/app-icons/yue2.png`

# Изменённые файлы

SnarkRoute:

- `apps/server/src/routes/system.ts`
- `apps/server/test/system-apps.test.ts`
- `apps/launcher/src/main.tsx`
- `apps/launcher/src/styles.css`

PersonaCore:

- `app/extension_bridge/http.py`
- `app/extension_bridge/workshop.py`
- `extension/src/persona/client.ts`
- `extension/src/sidepanel/Workshop.tsx`
- `extension/src/sidepanel/style.css`
- `functions/registry.json`
- `tests/test_functions.py`

# Standalone запуск

Двойной клик по `start_yue2.bat` проверяет `/health`, запускает сервис скрыто в существующем `Ubuntu-24.04`, ждёт состояния `ready` и открывает Web UI. Если сервис уже запущен, новый процесс не создаётся. `stop_yue2.bat` вызывает `/shutdown` и останавливает только YuE2, не выключая WSL.

# Мастерская

В «Мастерской» добавлена плитка YuE2 с компактной золотой иконкой. Плитки выровнены по ширине. Состояния: остановлен, запускается, загружается, готов, генерирует, ошибка. Основная кнопка запускает сервис либо открывает уже работающий UI; рядом доступны «Результаты» и «Остановить».

# Persona / Claude

Persona Chrome panel получила одну компактную плитку YuE2 рядом с другими приложениями, золотую иконку и живой статус. Нажатие запускает сервис при необходимости и открывает Web UI. Authenticated Persona bridge дополнительно предоставляет команды:

- `GET /yue2/status`
- `POST /yue2/start`
- `POST /yue2/open`
- `POST /yue2/stop`
- `POST /yue2/outputs`

В Persona function registry зарегистрированы алиасы `yue2_status`, `start_yue2`, `open_yue2`, `stop_yue2`, `open_yue2_outputs`. Claude обращается к Persona bridge; браузер не получает прямого доступа к WSL shell.

# YuE2 API

Проверена установленная версия `yue2-infer 0.1.6`. Использованы реальные публичные методы `YuE2Pipeline.from_pretrained`, `plan`, `generate_semantic`, `synthesize`, `decode` и `SongResult.save_artifacts`.

Поддержаны `style`, `lyrics`, `seed`, `cot` (`full`, `melody`, `off`), `cfg_scale`, `ode_steps`, ABC/semantic sampling overrides и внешний ABC. Отредактированный ABC передаётся как новый `abc` input: планирование пропускается, затем заново выполняются semantic generation, synthesis и decoding. Это официальный поддержанный путь; изменение сохранённого `SymbolicPlan` на месте запрещено проверкой integrity в YuE2.

Pipeline создаётся один раз на процесс. YuE2 лениво загружает AR weights при первой генерации и при декодировании переносит AR model на CPU; объект и веса остаются в памяти и не читаются с диска перед каждым запросом.

# WebUI

Интерфейс содержит style, lyrics, seed, CoT mode, CFG, ODE steps, sampling, Generate, Stop, status/log, счётчики токенов, аудиоплеер, session history, output path, открытие папки и editable ABC с кнопкой повторного рендера. Широкий золотой логотип используется в шапке; компактная `Y` — как favicon. Во время загрузки/генерации favicon получает вращающийся световой индикатор, а title показывает текущую стадию.

# Health endpoints

- `GET http://127.0.0.1:7862/health`
- `GET http://127.0.0.1:7862/status`
- `POST http://127.0.0.1:7862/generate`
- `POST http://127.0.0.1:7862/stop-generation`
- `POST http://127.0.0.1:7862/open-output-folder`
- `POST http://127.0.0.1:7862/shutdown`

Health содержит идентификатор сервиса, status, stage, model_loaded, generating и error. `/status` дополнительно возвращает текущий run, историю сессии и журнал стадий.

# Реально проведённые тесты

- PASS — запуск при выключенном YuE2 через Windows launcher.
- PASS — повторный запуск сохранил тот же PID; вторая копия не появилась.
- PASS — `/health` вернул `service=YuE2`, `status=ready`, `model_loaded=true`.
- PASS — Web UI и PNG assets вернули HTTP 200.
- PASS — реальная короткая генерация из существующего editable ABC прошла стадии semantic generation, synthesis, decoding, completed.
- PASS — создан `audio.flac`: 48 kHz, stereo, 460736 frames, 9.5987 секунды, около 1.2 MB.
- PASS — сохранены `score.abc`, `plan.json`, semantic tokens, latents, config и result metadata.
- PASS — `stop_yue2.bat`, offline health и повторный idempotent stop.
- PASS — повторный запуск после stop.
- PASS — «Мастерская» вернула YuE2 status/open; повторный open сообщил `started=false`.
- PASS — Persona bridge: status, open, outputs, stop, status=stopped, start, status=ready.
- PASS — favicon DOM-тест: статический PNG сменился на анимированный data frame и восстановился после завершения.
- PASS — все 6 плиток «Мастерской» имеют одинаковую ширину 408 px при тестовом viewport.
- PASS — SnarkRoute server и launcher TypeScript/Vite builds.
- PASS — 5 focused Vitest tests для app catalog и YuE2 health contract.
- PASS — Persona extension production build и 10 focused unittest tests.

Smoke generation намеренно ограничила semantic output 240 токенами и была отмечена `semantic: truncated`; это ожидаемо для короткого и дешёвого smoke test, полученный FLAC валиден.

# Обнаруженные ограничения

- YuE2 не предоставляет безопасную операцию редактирования сохранённого `SymbolicPlan` на месте. Для изменённого ABC нужен новый request с `abc`.
- Повторный рендер ABC пропускает создание плана, но semantic/acoustic/decode стадии должны выполняться заново.
- Точный общий процент для planning и semantic заранее неизвестен; UI показывает стадии и фактически выпущенные токены. Synthesis/decoder progress доступен внутри pipeline, но публичные методы не дают внешний callback для каждого шага.
- После decode YuE2 переносит AR model на CPU для освобождения VRAM; pipeline остаётся живым, но следующий AR этап снова переносит уже загруженные веса на GPU.
- Browser extension нужно перезагрузить на странице `chrome://extensions`, чтобы Chrome подхватил новую production-сборку панели.

# Что пришлось решить самостоятельно

Использован FastAPI в существующем YuE venv без обновления Torch/CUDA. Для надёжного запуска добавлен маленький WSL shell launcher под PowerShell polling; он не требует sudo. Для Persona использован существующий authenticated native bridge. Порт проверяется по health contract, поэтому посторонний процесс на 7862 отображается как ошибка.

# Известные проблемы

Отдельные `/plan` и `/synthesize` endpoints не добавлены: рабочий UI уже даёт официальный ABC round-trip через `/generate`, а отдельное хранение изменяемых промежуточных объектов усложнило бы lifecycle без пользы. История намеренно хранится только до перезапуска сервиса; сами generation artifacts остаются на диске.

# Что осталось сделать вручную

Только перезагрузить установленное unpacked Persona Chrome extension, если Chrome ещё показывает старую сборку панели. Сервис YuE2 оставлен запущенным и готовым.

# Как проверить всё утром

```powershell
Invoke-RestMethod http://127.0.0.1:7862/health
Invoke-RestMethod http://127.0.0.1:7862/status
Start-Process http://127.0.0.1:7862
cmd /c stop_yue2.bat
cmd /c start_yue2.bat
```

# MORNING CHECKLIST

1. Откройте «Мастерскую» и нажмите плитку YuE2.
2. Проверьте новый логотип и запустите короткую генерацию.
3. Во время генерации посмотрите на анимированную иконку вкладки.
4. Перезагрузите Persona extension в `chrome://extensions` и проверьте плитку YuE2.
5. При желании откройте результаты через кнопку «Результаты».
