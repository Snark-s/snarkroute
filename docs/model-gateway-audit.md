# Model Gateway Audit

## Current Model Data

- `data/model-registry/openrouter-mappings.json` is loaded by `apps/server/src/execution/model-gateway-runners.ts` and currently maps UI model ids such as `text.default` or `image.nano-banana` to OpenRouter/direct/local execution routes.
- `packages/protocol/src/model-registry.ts` contains portable profile/preset schemas. That file is route/protocol-oriented metadata, not an execution gateway.
- `apps/studio/src/main.tsx` contains provider-facing UI state, model lists, example routes, and OpenRouter settings controls.
- `apps/server/src/providers/provider-node-manifests.ts` contains bundled provider node manifests and permission declarations.
- Provider catalog data for OpenRouter is cached in `data/cache/openrouter-models.json` through `apps/server/src/routes/providers.ts`.

## Current Provider API Calls

- `packages/adapters/openrouter/src/index.ts` owns OpenRouter HTTP calls and exposes an OpenRouter `ProviderAdapter`.
- `packages/adapters/replicate/src/index.ts` owns Replicate HTTP calls and exposes a Replicate `ProviderAdapter`.
- `packages/adapters/gemini/src/index.ts` owns Gemini HTTP calls and exposes a Gemini `ProviderAdapter`.
- `packages/adapters/polza/src/index.ts` owns Polza HTTP calls and exposes a Polza `ProviderAdapter`.
- `apps/server/src/routes/providers.ts` calls provider APIs for non-execution settings/catalog endpoints: connection tests, model catalog refresh, OpenRouter model reads, Polza model reads, and Replicate schema reads.
- `apps/server/src/execution/service.ts` registers provider-specific runners directly with the executor.

## Execution Path Migration Table

| Node / module | Provider | Current execution path | Migrated to ModelGateway | Reason if no | Tests covering it |
| --- | --- | --- | --- | --- | --- |
| `replicate.model` | Replicate | node runner -> `ModelGateway.invoke` -> Replicate `ProviderAdapter` -> `createReplicateClient().runPrediction` | yes |  | `packages/adapters/replicate/test/replicate.test.ts` |
| `replicate.clarity-upscaler` | Replicate | node runner -> `ModelGateway.invoke` -> Replicate `ProviderAdapter` -> `runPrediction`; runner keeps image download/output shaping | yes |  | `packages/adapters/replicate/test/replicate.test.ts`, `apps/server/test/replicate-registration.test.ts` |
| `gemini.llm` | Gemini | node runner -> `ModelGateway.invoke` -> Gemini `ProviderAdapter` -> `generateText` | yes |  | `packages/adapters/gemini/test/gemini.test.ts` |
| `gemini.nano-banana-2` | Gemini | node runner -> `ModelGateway.invoke` -> Gemini `ProviderAdapter` -> `generateContent`; adapter writes image asset | yes |  | `packages/adapters/gemini/test/gemini.test.ts` |
| `polza.text` | Polza | node runner -> `ModelGateway.invoke` -> Polza `ProviderAdapter` -> chat completions | yes |  | `packages/adapters/polza/test/polza.test.ts`, `apps/server/test/replicate-registration.test.ts` |
| `polza.image.generate` | Polza | node runner -> `ModelGateway.invoke` -> Polza `ProviderAdapter` -> image/media endpoint | yes |  | `packages/adapters/polza/test/polza.test.ts` |
| `ai.text` OpenRouter route | OpenRouter | `apps/server/src/execution/model-gateway-runners.ts` compatibility resolver -> gateway-backed OpenRouter runner -> OpenRouter `ProviderAdapter` | yes |  | `packages/adapters/openrouter/test/openrouter.test.ts`, `apps/server/test/provider-neutral-routing.test.ts` |
| `ai.text` direct Gemini route | Gemini | `apps/server/src/execution/model-gateway-runners.ts` compatibility resolver -> gateway-backed Gemini runner -> Gemini `ProviderAdapter` | yes |  | `packages/adapters/gemini/test/gemini.test.ts`; server route behavior covered indirectly by existing execution tests |
| `ai.image.generate` OpenRouter route | OpenRouter | `apps/server/src/execution/model-gateway-runners.ts` compatibility resolver/catalog check -> gateway-backed OpenRouter runner -> OpenRouter `ProviderAdapter` | yes |  | `packages/adapters/openrouter/test/openrouter.test.ts`, `apps/server/test/image-generation-routing.test.ts`, `apps/server/test/provider-neutral-routing.test.ts` |
| `ai.image.generate` direct Gemini route | Gemini | `apps/server/src/execution/model-gateway-runners.ts` compatibility resolver -> gateway-backed Gemini image runner -> Gemini `ProviderAdapter` | yes |  | `packages/adapters/gemini/test/gemini.test.ts`, `apps/server/test/image-generation-routing.test.ts` |
| `apps/server/src/routes/providers.ts` settings/catalog endpoints | OpenRouter / Polza / Replicate | route handler -> provider client for status/catalog/schema | no | Not model execution; these are settings/catalog helper endpoints and do not invoke workflow models. TODO: wrap catalog listing in provider adapter `listModels` if the UI starts using gateway-managed model catalogs. | server provider/settings tests |

## Direct Node Dependencies

- `ai.text` uses `apps/server/src/execution/model-gateway-runners.ts` as a provider-neutral compatibility resolver for legacy params (`model`, `providerMode`), then invokes gateway-backed OpenRouter or Gemini runners.
- `ai.image.generate` uses the same provider-neutral server compatibility resolver/catalog check, then invokes gateway-backed OpenRouter or Gemini runners.
- `replicate.model`, `replicate.clarity-upscaler`, `gemini.llm`, `gemini.nano-banana-2`, `polza.text`, and `polza.image.generate` call `ModelGateway.invoke` before any provider API request.

## Mixed Boundaries

- `apps/server/src/execution/model-gateway-runners.ts` intentionally owns compatibility routing for logical model ids such as `image.nano-banana`.
- `apps/server/src/providers/openrouter.ts` is OpenRouter-specific: settings status, catalog cache reads, masking, and public OpenRouter error wording.
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
- Keep Model Gateway v0 as an execution-layer abstraction in `packages/core/src/model-gateway`.
- Preserve public node params/output while routing model execution through gateway wrappers.
- Prefer `credentialRef`/`secretRef` on gateway connections and keep actual credentials in local env/settings.

## Future Work

- Move provider catalog/status endpoints toward `ProviderAdapter.listModels` where that improves consistency without mixing execution and settings.
- Add route validation warnings if a route/node param key looks like a secret even before export stripping.
- Consider splitting provider settings/model UI out of `apps/studio/src/main.tsx`.
- Consider a shared gateway factory in the server once more providers need cross-provider orchestration. Do not add smart model selection until a separate model selection policy exists.
- Polza remains explicit node types (`polza.text`, `polza.image.generate`) and is not yet included in logical `ai.text` / `ai.image.generate` routing. TODO: add Polza mapping entries only after defining a stable provider preference value that does not change ORP route format or existing `providerMode` semantics.

## Not In v0

- No smart model selection.
- No cost-based routing.
- No benchmark-based routing.
- No remote registry.
- No marketplace, billing, accounts, or provider settings redesign.
