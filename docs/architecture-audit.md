# Architecture Audit

## Current Structure

- `apps/studio`: React Flow graph editor, route editing, settings UI, provider settings, prompt library UI, installed node package management, execution controls, and local asset interactions.
- `apps/server`: Fastify API for settings, providers, installed node packages, examples, saved routes, prompt library mutation, assets, validation, execution, and ledger reads.
- `packages/protocol`: route schema, validation, import/export, filename handling, and secret stripping.
- `packages/executor`: execution runtime, capability provider selection, compound subroutes, template resolution, economics summaries, and ledger writes.
- `packages/adapters`: provider-specific API clients/runners for Gemini, OpenRouter, and Replicate.
- `packages/nodes`: built-in manifests, installed package handling, node library validation, prompt library loading, and package utilities.
- `packages/storage`: local run storage.

## Large Files Found

- `apps/studio/src/main.tsx`: about 5,600 lines. It mixes UI components, catalog data, example routes, API clients, provider settings, route transformations, prompt asset workflows, local asset handling, execution controls, React Flow integration, and formatting helpers.
- `apps/server/src/index.ts`: previously about 1,270 lines and mixed server creation, route registration, provider settings, node package installation endpoints, prompt asset mutation, PNG metadata writing, asset import/preview, route execution registration, provider runners, provider manifests, local file browsing, and ledger helpers. It is now a bootstrap file that loads dotenv and starts `server.ts`.
- `apps/studio/src/styles.css`: about 2,250 lines. It is large but mostly styling, so it is less risky than `main.tsx`.

## Mixed Responsibilities

`apps/studio/src/main.tsx` currently mixes:

- React layout and component rendering.
- BoojumRoute block catalog definitions.
- Open Route Protocol document conversion.
- Example route documents.
- API calls and response shape normalization.
- Provider model UI rules.
- Prompt library browsing and mutation UI.
- Installed node package/library UI.
- Local file import and clipboard image conversion.
- Execution state and run result formatting.

`apps/server/src/index.ts` currently mixes:

- `apps/server/src/app.ts`: Fastify setup and registration of route modules.
- `apps/server/src/routes/*`: route/controller layer for settings, providers, node catalog/packages, route documents, prompt library, assets, execution, run results, local Stable Diffusion, and ledger reads.
- `apps/server/src/providers/*`: provider manifests and OpenRouter-specific status, catalog, model resolution, error wording, and runner glue.
- `apps/server/src/execution/service.ts`: executor and runner registration.
- `apps/server/src/prompt-library/service.ts`: prompt asset mutation and PNG prompt asset generation.
- `apps/server/src/assets/service.ts`: asset filename sanitation and Windows file browser glue.
- `apps/server/src/node-packages/service.ts`: upload normalization, remote fetch helpers, package warnings, and package preview error shaping.
- `apps/server/src/ledger/service.ts`: ledger read, secret stripping, and summary helpers.

## Provider Logic Audit

Provider adapter packages already exist and are the correct boundary for API calls. Server-side provider routing glue now lives outside the root bootstrap: `routes/providers.ts` owns HTTP endpoints, while `providers/openrouter.ts` owns OpenRouter catalog/status/resolution glue and `providers/provider-node-manifests.ts` owns bundled provider node manifests.

### 2026-05-15: Model Registry and Dialogue Workbench

Model Registry phase 1 keeps provider APIs outside core. Portable profile and agent-preset types live in `packages/protocol/src/model-registry.ts` and are re-exported by `packages/core` for future SnarkRoute use. Profiles describe intent and metadata; credentials remain in local settings.

Dialogue Workbench phase 1 adds `packages/protocol/src/dialogue-workbench.ts` for state and system output generation, `packages/nodes/src/index.ts` for the no-hidden-spend runner, and `apps/studio/src/main.tsx` for the BoojumRoute Lab editor. Execution emits saved transcript/capsule/selected outputs and performs no automatic model calls.

## Runtime / Execution Audit

`packages/executor` is a reasonable shared runtime package. It still uses `NodeRunner`, `NodeResult`, and related names because the Open Route Protocol compatibility surface is node-based. For BoojumRoute, these are now conceptually block runners.

## Schema / Protocol Audit

`packages/protocol` validates Open Route Protocol documents and should remain backward compatible. Public fields such as `nodes`, `nodePackage`, and `subroute` should not be renamed without a documented migration.

## Prompt Library Audit

Prompt library loading lives in `packages/nodes`, but prompt asset mutation and PNG text chunk writing live in `apps/server/src/index.ts`. Those server helpers should move into a prompt-library service module.

## Installed Nodes / Tools Audit

Installed node package utilities live in `packages/nodes`; UI and API still use node terminology because package filenames, manifests, and endpoints are compatibility surfaces. BoojumRoute docs/UI now describe them as blocks/tools conceptually.

## Storage / Data Audit

Run storage is isolated in `packages/storage`. Asset import/preview, prompt assets, `.env`, provider mappings, and ledger reads still live in the server entry file. These should become focused server services.

## Recommended Next Refactors

1. Add focused tests around server route modules and service boundaries as future behavior changes happen.
2. Split `apps/studio/src/main.tsx` into route conversion helpers, API client helpers, block catalog components, inspector panels, settings panels, prompt library panels, and React Flow canvas components.
3. Continue moving provider-specific behavior toward provider packages when it becomes reusable across server surfaces.
4. Keep "blocks" as UI/product language and "nodes" as protocol/API/storage language until a documented protocol migration exists.
