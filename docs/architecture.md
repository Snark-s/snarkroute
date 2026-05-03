# SnarkRoute Architecture

## Studio

`apps/studio` is a Vite + React + React Flow editor. It edits route graphs, imports and exports `.route.json`, validates routes through the local API, runs routes, and displays logs and outputs.

## Server

`apps/server` is a local Fastify API. It loads `.env`, registers built-in node runners, registers the Replicate runner when `REPLICATE_API_TOKEN` exists, executes routes, and stores runs under `data/runs`.

## Protocol

`packages/protocol` owns Open Route Protocol v0.1 schemas, parsing, validation, YAML/JSON loading, and exporting. It allows unknown node types so route documents stay portable.

## Executor

`packages/executor` owns DAG execution, topological sorting, cycle detection, template resolution, runner registration, run logs, node results, and provenance output.

## Nodes

`packages/nodes` contains safe built-in runners: text input, local file/image/video inputs, template transform, debug log, text output, and local output file.

Local asset input nodes keep the protocol simple: the route stores `params.path`, the executor reads metadata from the local filesystem, and Studio uses the local server for file browsing, metadata, and image previews. The MVP does not upload files or create an asset registry.

For the Clarity Upscaler milestone, the image flow is:

```text
local image asset -> input.image metadata -> Replicate data URI input -> prediction output URL -> downloaded local asset -> Studio preview + output.text metadata
```

Replicate output URLs can expire, so the model-specific runner downloads the first returned image into `data/runs/<runId>/assets/` and returns both the original URL and local metadata.

Studio keeps Clarity outputs explicit: the `image` port carries downloaded image metadata for the inline image result, while the `output` port carries the full run result for `output.text` or an explicit save-to-file node. Estimated cost is computed after the prediction from provider timing metrics and SnarkRoute's default per-second estimate.

## Adapters

`packages/adapters/replicate` contains the first external provider adapter. It uses `fetch`, reads tokens only on the server, creates predictions, polls terminal status, and returns normalized results.

## Economics Flow

SnarkRoute v0.1 treats economics as metadata and local run accounting:

```text
route economics metadata
-> executor run accounting
-> provider usage events from node runners
-> run.json economics summary
-> data/ledger/runs.jsonl local ledger
-> Studio Economics / Ledger panel
```

The executor sets `paymentExecuted: false` for every run. Replicate runners emit provider usage events with provider, model, node id, prediction id, status, and metrics when available. No billing API calls are made, and actual provider costs may remain `null`.

The ledger is local-only and ignored by git. It is never exported as part of `.route.yaml` or `.route.json`, and secret-like keys are filtered from ledger API responses.

## Storage

`packages/storage` provides local filesystem run storage. The MVP avoids a database.

## Future Extension Points

Future nodes should be declarative and permissioned. A future registry can distribute manifests, schemas, and permission declarations, but SnarkRoute should not execute arbitrary community JavaScript.

---

This document is licensed under CC BY-SA 4.0.
