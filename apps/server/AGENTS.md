# Server Agent Instructions

- `/api/models` is the server-facing unified catalog endpoint.
- It must use `@snarkroute/model-catalog` for curated model metadata.
- Do not change legacy provider endpoints unless explicitly requested.
- Do not merge live provider catalogs into `/api/models` unless the task explicitly asks.
- Do not infer model type, icon, or parameters in server routes.
