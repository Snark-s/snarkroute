# Declarative HTTP Executor

`executor.type: "declarative.http"` lets simple API-backed nodes run without custom executor code.

Supported fields:

- `method`: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`
- `urlTemplate`
- `headersTemplate`
- `queryTemplate`
- `bodyMode`: `none`, `json`, or `text`
- `bodyTemplate`
- `response.mode`: `json` or `text`
- `response.mappings`: output id to `$.field.path`, `$json`, `$`, or `$text`
- `timeoutMs`

Templates can reference `{{params.name}}` and `{{inputs.name}}`.

The executor runs on the backend, handles non-2xx responses as node errors, and redacts secret-like URL query parameters in provenance.
