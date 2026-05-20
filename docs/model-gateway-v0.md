# Model Gateway v0

Model Gateway is the small execution layer between nodes and provider APIs.

Nodes ask for a capability, such as `text.generate` or `image.generate`. The gateway resolves a model, finds the provider adapter, reads the provider connection reference, calls the adapter, and returns a normalized result.

## Why It Exists

Before v0, some nodes and server runner glue knew too much about concrete providers. That made it easy for node behavior, provider routing, settings, and API details to grow together.

The gateway keeps nodes focused on workflow behavior. Provider-specific URL construction, request bodies, polling, and response details stay behind provider adapters.

## Core Concepts

- `ModelCapability`: an extensible string capability such as `text.generate`, `image.generate`, or `embedding.create`.
- `ModelInfo`: local metadata about a model, including provider id, capabilities, optional input/output types, hints, and non-authoritative pricing/quality/speed hints.
- `ModelRegistry`: in-memory registry in `packages/core/src/model-gateway` that can register models, find by capability, find by `model://provider/model` reference, and list models.
- `GatewayModelResolver`: v0 resolver that chooses an explicit `modelRef` first, otherwise picks the first enabled model matching the requested capability, with simple hint sorting when preferences are present.
- `ProviderConnection`: local provider connection metadata. It uses `credentialRef` or `secretRef`; raw API keys do not belong in route or node settings.
- `ProviderAdapter`: provider boundary with `id`, `title`, `capabilities`, optional `listModels`, and `invoke`.
- `ModelGateway`: central entrypoint. `invoke(request)` resolves the model, selects the adapter, gets the connection, calls `adapter.invoke`, and returns a `ModelInvokeResult`.

## Request Shape

```ts
await gateway.invoke({
  capability: "image.generate",
  modelRef: "model://replicate/black-forest-labs/flux-schnell",
  input: { prompt: "a compact route diagram" },
  parameters: { timeoutMs: 120000 },
  preferences: { speed: "fast" }
});
```

## Example Flow

Node asks:

```ts
{ capability: "image.generate" }
```

Gateway resolves:

```text
provider: replicate
model: flux-schnell
```

Adapter invokes:

```text
Replicate API
```

Node receives:

```ts
{
  modelId: "black-forest-labs/flux-schnell",
  providerId: "replicate",
  capability: "image.generate",
  output: { image: "..." }
}
```

## Adding a Provider Adapter

1. Keep HTTP/network code inside the provider adapter package.
2. Implement `ProviderAdapter`.
3. Register provider models with `ModelRegistry` or construct a gateway with built-in model metadata.
4. Register a `ProviderConnection` using `credentialRef` or `secretRef`.
5. Update one node runner to call `ModelGateway.invoke` while preserving its existing params and output.
6. Add focused compatibility tests for the migrated node.

## Current v0 State

- `@snarkroute/model-registry` contains neutral mapping/resolution extracted from OpenRouter.
- `packages/core/src/model-gateway` contains the gateway types, registry, resolver, and gateway.
- `@snarkroute/replicate` exposes a Replicate `ProviderAdapter` for `image.generate` and `image.upscale`.
- `@snarkroute/openrouter` exposes an OpenRouter `ProviderAdapter` for `text.generate` and `image.generate`.
- `@snarkroute/gemini` exposes a Gemini `ProviderAdapter` for `text.generate` and `image.generate`.
- `@snarkroute/polza` exposes a Polza `ProviderAdapter` for `text.generate` and `image.generate`.
- Existing model-executing nodes keep their public params/output shape while invoking providers through Model Gateway v0.
- Server compatibility glue for `ai.text` and `ai.image.generate` lives in `apps/server/src/execution/model-gateway-runners.ts`. It resolves legacy `model` / `providerMode` params before calling gateway-backed provider runners.
- `apps/server/src/providers/openrouter.ts` is OpenRouter-specific and does not import Gemini direct runners.
- Polza is available through explicit `polza.text` and `polza.image.generate` nodes. It is not yet part of logical `ai.text` / `ai.image.generate` routing.

## Not Implemented

- No smart model selection.
- No cost-based routing.
- No benchmark-based routing.
- No remote registry.
- No model marketplace or billing.
- No provider settings UI redesign.
- No public route/ORP format changes.
- No automatic migration of route files; old route params remain supported by compatibility wrappers.
- No Polza auto/provider-preference route in logical model routing yet.
