# Смотритель: Bonsai port migration 2026-10-20

Изменение только в этой ветке:

| Источник | Было | Стало | Проверка |
| --- | ---: | ---: | --- |
| `service-endpoints.json` → `bonsai_inference.port` | 8081 | 8092 | registry-порт уникален; `/v1/models` не запускался |
| `local_upscale.port` | 8091 | 8091 | не менялся; 8091 уже занят этим runtime |
| SnarkRoute local OpenAI/model discovery | registry-derived 8081 | registry-derived 8092 | существующие mock-тесты обновлены |

`local-openai.ts` не содержит отдельного hardcoded Bonsai-порта: базовый URL
строится через `localServiceUrl("bonsai_inference", "/v1")`. Поэтому перенос
registry покрывает SnarkRoute provider/model discovery и прямой server-side
endpoint. Tove и Local Process Manager в этот worktree не входят и не менялись.

## Что должен сделать владелец в live-конфигурации

После проверки чистоты live-файла и копии рядом с ним в формате
`30_BACKUP` предложенная правка:

- Local Process Manager: Bonsai launch `--port 8081` → `--port 8092`.
- Tove direct `http://127.0.0.1:8081/v1` →
  `http://127.0.0.1:8092/v1` во всех разрешённых Bonsai endpoint/model
  references.
- Не менять NVIDIA Broadcast на `8081` и не освобождать `8091` принудительно.

После этого нужен owner-authorized smoke `GET
http://127.0.0.1:8092/v1/models`, ожидаемый HTTP 200 с OpenAI-compatible
`object=list`/`data[].id`. В этот запуск smoke и запуск Bonsai намеренно не
выполнялись: это потребовало бы GPU/локальной модели.
