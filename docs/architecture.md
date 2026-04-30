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

`packages/nodes` contains safe built-in runners: text input, template transform, debug log, and local output file.

## Adapters

`packages/adapters/replicate` contains the first external provider adapter. It uses `fetch`, reads tokens only on the server, creates predictions, polls terminal status, and returns normalized results.

## Storage

`packages/storage` provides local filesystem run storage. The MVP avoids a database.

## Future Extension Points

Future nodes should be declarative and permissioned. A future registry can distribute manifests, schemas, and permission declarations, but SnarkRoute should not execute arbitrary community JavaScript.
