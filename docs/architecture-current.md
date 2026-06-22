# Current Architecture

Updated: 2026-06-14

## Product Split

- SnarkRoute is the Living Canvas shell in `apps/snarkroute`.
- BoojumRoute Lab is the React Flow route editor in `apps/studio`.
- `apps/server` is the local API boundary for settings, providers, execution, libraries, assets, and diagnostics.

## Model Catalog V1

- Normal UI catalog loading uses `GET /api/models/v1`.
- Node-executable picker options use `GET /api/models/for-node/:nodeType`.
- `GET /api/models` remains a legacy compatibility wrapper backed by V1.
- `GET /api/providers/*/models` endpoints are raw provider/server diagnostics, not normal UI catalog sources.
- `model-registry/openrouter-mappings.json` remains execution routing data, not UI catalog truth.
- Curated/canonical V1 metadata is an overlay, not a whitelist.
- Custom/user-defined models remain separate picker entries and do not redefine provider catalog truth.

## Provider Identity

- Provider means where execution happens, such as Polza or OpenRouter.
- Origin vendor/model family means the model identity shown in UI icons and labels.
- Shared model icon resolution now lives in `@snarkroute/model-catalog`; Studio and Living Canvas keep thin local wrappers for their API base URL.

## Execution

- `packages/executor` owns route execution, capability provider selection, template resolution, economics summaries, and billing metadata.
- Provider-specific API behavior stays in adapters/provider layers.
- HTTP 2xx provider usage statuses are treated as successful billable completions by the executor billing layer.

## Current Monoliths

- `apps/studio/src/main.tsx` remains large, but model option/catalog helpers were moved to `apps/studio/src/features/model-catalog/modelOptionUtils.ts`.
- `apps/snarkroute/src/main.tsx` remains large; the shared icon resolver removed one duplicate frontend concern without a broader component split.
- `apps/server/src/libraries/service.ts` now imports its public library/canvas/input types from `apps/server/src/libraries/types.ts`.
- `packages/nodes/src/index.ts` and `packages/executor/src/index.ts` still need staged splits. Plans live in:
  - `docs/refactor-notes/nodes-registry.md`
  - `docs/refactor-notes/executor-pricing.md`

## Guardrails

- Do not change ORP route fields, storage keys, `.snarknode` behavior, or model execution routing without an explicit migration.
- Keep provider-specific behavior outside UI and outside protocol packages.
- Keep local/runtime artifacts out of commits.
