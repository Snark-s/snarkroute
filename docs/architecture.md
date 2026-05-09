# SnarkRoute Architecture

## Studio

`apps/studio` is a Vite + React + React Flow editor. It edits route graphs, imports Open Route Protocol documents, exports `.orp` by default, validates routes through the local API, runs routes, and displays logs and outputs.

## Server

`apps/server` is a local Fastify API. It loads `.env`, registers built-in node runners, registers the Replicate runner when `REPLICATE_API_TOKEN` exists, executes routes, and stores runs under `data/runs`.

## Protocol

`packages/protocol` owns Open Route Protocol v0.1 schemas, parsing, validation, YAML/JSON loading, extension detection, export filename normalization, and exporting. It allows unknown node types so route documents stay portable.

Open Route Protocol describes routes as graphs of operations. Routes can contain AssetRefs, but they must not directly load JSON, Markdown, files, URLs, node definitions, or remote resources. The host application owns asset resolution.

## Asset System

SnarkRoute has a two-level architecture:

- Route level: routes contain nodes, edges, params, and AssetRefs.
- Asset resolution level: the host configures AssetSources and uses AssetResolver to turn AssetRefs into normalized assets.

AssetResolver validates schema, kind, version, hash, permissions, and trust rules where applicable. A normalized asset is the validated object that the executor or UI can safely use.

Core types:

- AssetRef: a reference stored in a route.
- AssetSource: a configured source of assets, such as `local-folder`, `embedded`, `bundle`, `remote-manifest`, `github`, or a future provider-specific source.
- AssetResolver: the host service that resolves AssetRefs.
- Normalized Asset: a validated asset object with schema, kind, id, version, metadata, and content.

Linked, embedded, and bundle are export modes. A node does not decide whether an asset is linked or embedded.

## Executor

`packages/executor` owns DAG execution, topological sorting, cycle detection, template resolution, runner registration, run logs, node results, and provenance output.

## Nodes

`packages/nodes` contains safe built-in runners: text input, local file/image/video inputs, template transform, debug log, text output, and local output file.

In Open Route Protocol terminology, a node is a portable operation definition. A provider or implementation is how that operation is executed. The executor is the runtime that executes a route; it is not the protocol itself.

Local asset input nodes keep the protocol simple: the route stores `params.path`, the executor reads metadata from the local filesystem, and Studio uses the local server for file browsing, metadata, and image previews. The MVP does not upload files or create an asset registry.

Direct local input paths are an MVP input-node convenience. Reusable resources should use AssetRef so the route remains portable and auditable.

## Prompt Library

Prompt Library is the first Text Asset source. Prompt files are human-editable Markdown files under `data/prompt-library/**/*.prompt.md`, parsed from YAML frontmatter plus body text and normalized into `text/prompt` assets.

Current MVP routes store linked prompt params as `category`, `promptId`, and `mode: "linked"`, with `embeddedText` available for `mode: "embedded"`. During execution, `library.prompt` resolves the local library prompt or embedded text and outputs `{ "text": "<resolved prompt text>" }`.

The target AssetRef architecture should move this to `params.assetRef`, so the node does not know whether the prompt came from a local file, embedded route asset, bundle, remote manifest, or future provider.

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

The ledger is local-only and ignored by git. It is never exported as part of `.orp`, `.orp.yaml`, `.route.yaml`, or `.route.json`, and secret-like keys are filtered from ledger API responses.

## Storage

`packages/storage` provides local filesystem run storage. The MVP avoids a database.

## Future Extension Points

Future nodes should be declarative and permissioned. A future registry can distribute manifests, schemas, and permission declarations, but it is an optional discovery mechanism, not the source of truth.

Remote Node Definition Assets may describe node id, title, version, inputs, outputs, UI metadata, execution adapter, endpoint or provider type, required permissions, and required credentials. They must not silently inject arbitrary executable JS/TS/Python code into SnarkRoute. The host must show permissions before enabling external node definitions.

---

This document is licensed under CC BY-SA 4.0.
