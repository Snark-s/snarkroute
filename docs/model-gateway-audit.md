# Model Gateway Audit

## Current Model Data

- `data/model-registry/openrouter-mappings.json` is loaded by `apps/server/src/providers/openrouter.ts` and currently maps UI model ids such as `text.default` or `image.nano-banana` to OpenRouter/direct/local execution routes.
- `packages/protocol/src/model-registry.ts` contains portable profile/preset schemas. That file is route/protocol-oriented metadata, not an execution gateway.
- `apps/studio/src/main.tsx` contains provider-facing UI state, model lists, example routes, and OpenRouter settings controls.
- `apps/server/src/providers/provider-node-manifests.ts` contains bundled provider node manifests and permission declarations.
- Provider catalog data for OpenRouter is cached in `data/cache/openrouter-models.json` through `apps/server/src/routes/providers.ts`.

## Current Provider API Calls

- `packages/adapters/openrouter/src/index.ts` owns OpenRouter HTTP calls and node runners for `ai.text` / OpenRouter image generation.
- `packages/adapters/replicate/src/index.ts` owns Replicate HTTP calls and runners for `replicate.model` and `replicate.clarity-upscaler`.
- `packages/adapters/gemini/src/index.ts` owns Gemini calls used by `gemini.llm`, `gemini.nano-banana-2`, and direct fallback from server OpenRouter glue.
- `packages/adapters/polza/src/index.ts` owns Polza text/image calls.
- `apps/server/src/routes/providers.ts` calls provider APIs for connection tests, model catalog refresh, OpenRouter model reads, and Replicate schema reads.
- `apps/server/src/execution/service.ts` registers provider-specific runners directly with the executor.

## Direct Node Dependencies

- `ai.text` currently uses `apps/server/src/providers/openrouter.ts` as a compatibility router. It may call OpenRouter directly or delegate to Gemini direct mode.
- `ai.image.generate` currently uses the same server OpenRouter glue and may call OpenRouter or Gemini direct mode depending on mapping/catalog resolution.
- `replicate.model` now calls Model Gateway v0 first, using a Replicate provider adapter while preserving the old output shape.
- `replicate.clarity-upscaler`, `gemini.llm`, `gemini.nano-banana-2`, `polza.text`, and `polza.image.generate` still call their provider adapters directly.

## Mixed Boundaries

- `apps/server/src/providers/openrouter.ts` mixes model mapping, provider selection, credential availability checks, OpenRouter catalog interpretation, Gemini direct fallback, and node runner glue.
- `apps/studio/src/main.tsx` mixes UI, example routes, provider settings, model status, and provider-specific controls.
- `apps/server/src/routes/settings.ts` persists local provider secrets into `.env`; this is appropriate for local settings, but it should remain outside route/node settings.
- `packages/adapters/*` are the right low-level API boundary. Gateway adapters should wrap those clients instead of moving HTTP details into nodes.

## Secret Handling

- Existing route export stripping in `packages/protocol/src/index.ts` removes keys matching `token|secret|password|api[_-]?key`.
- Ledger stripping in `apps/server/src/ledger/service.ts` applies the same class of redaction.
- Studio tests already check that route JSON does not include `REPLICATE_API_TOKEN`; protocol tests check route export secrets.
- Model Gateway v0 rejects `ProviderConnection` objects that carry raw fields such as `apiKey` or `token`; callers must use `credentialRef` or `secretRef`.
- Remaining risk: provider setting forms in `apps/studio/src/main.tsx` temporarily hold typed secrets in UI state before posting them to local settings. This is expected for settings UX, but those values must not be copied into route params or exported documents.

## Safe Changes Now

- Keep `@snarkroute/model-registry` as a neutral mapping/resolution package and re-export it from `@snarkroute/openrouter` for compatibility.
- Keep provider HTTP details in provider adapter packages.
- Introduce Model Gateway v0 as an execution-layer abstraction in `packages/core/src/model-gateway`.
- Migrate one existing provider node at a time through gateway wrappers while preserving public node params/output.
- Prefer `credentialRef`/`secretRef` on gateway connections and keep actual credentials in local env/settings.

## Future Work

- Move `ai.text` through gateway after adding an OpenRouter `text.generate` adapter and a Gemini direct adapter with compatibility tests.
- Move `ai.image.generate` through gateway after catalog-backed OpenRouter image resolution and Gemini direct image behavior are covered.
- Add gateway adapters for Gemini and Polza when migrating their nodes.
- Consider splitting provider settings/model UI out of `apps/studio/src/main.tsx`.
- Add validation warnings if a route/node param key looks like a secret even before export stripping.

## Not In v0

- No smart model selection.
- No cost-based routing.
- No benchmark-based routing.
- No remote registry.
- No marketplace, billing, accounts, or provider settings redesign.
