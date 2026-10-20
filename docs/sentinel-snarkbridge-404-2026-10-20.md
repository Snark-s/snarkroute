# Смотритель: SnarkBridge 404 2026-10-20

Анализ выполнен только чтением исходника `I:\SnarkBridge\server.py`,
`I:\SnarkBridge\README.md`, доступных workspace/service logs и ранее
сохранённых acceptance-evidence. SnarkBridge и tunnel-client не запускались и
не перезапускались.

## Наблюдение

- `server.py` создаёт `FastMCP(..., stateless_http=True)`.
- Сервер поднимает `mcp.streamable_http_app()` на loopback-порту registry
  `snarkbridge_mcp` и имеет custom `/health`.
- README объявляет MCP URL `http://127.0.0.1:8767/mcp`.
- В исходнике нет legacy SSE route `/sse`.
- Поэтому облачный запрос, который приходит как MCP SSE на `/sse` (или другой
  legacy SSE path), закономерно получает 404 до проверки tool/auth. Это
  несовместимость advertised transport/path, а не причина завершать чужой
  процесс.
- Контекст запуска сообщает отдельный 429 2026-10-15. Его следует считать
  upstream rate-limit/control-plane событием; он не доказывает и не исправляет
  локальный 404.

## Гипотеза и проверка владельцем

Гипотеза высокой уверенности: внешний коннектор или tunnel route всё ещё
использует SSE endpoint, тогда как текущий сервер ожидает Streamable HTTP на
`/mcp`. Проверить без изменения live: сверить public route и MCP client
transport с `/mcp`, затем выполнить read-only request к `/health` и отдельный
authenticated Streamable HTTP smoke на тестовом/изолированном порту.

Варианты исправления (не применялись):

1. перенастроить внешний connector на Streamable HTTP `/mcp`;
2. либо, после решения владельца, добавить совместимый `/sse` adapter в самом
   SnarkBridge и покрыть его isolated tests.

Нельзя считать причиной Bonsai/8081 и нельзя лечить 404 перезапуском MCP или
tunnel-client. Текущие live-конфиги и credentials не менялись.
