# Model Catalog V1

Model Catalog V1 is the planned single source of truth for model metadata across server, Studio, SnarkRoute, provider adapters, icons, parameters, pricing, and node selectors.

This document is a schema and migration plan only. V1 is not integrated yet, and existing `/api/models` behavior remains unchanged.

## Goals

- Keep live provider catalogs as the source of availability.
- Use curated catalog entries as metadata overlays, not whitelists.
- Prevent UI selectors from inferring output types, icons, roles, or parameters by model name.
- Keep provider-native selectors storing provider-native model ids.
- Move all selectors toward `GET /api/models/for-node/:nodeType`.

## Identity

- `id` is the unified catalog id, normally `provider:providerModelId`.
- `provider` is the execution provider, such as `polza`, `openrouter`, `gemini`, or `replicate`.
- `providerModelId` is the id sent to the provider or executor.
- `originVendor` is the underlying model vendor, such as `openai`, `google`, `qwen`, or `topaz`.

Example: a Polza-hosted OpenAI image model has `provider: "polza"`, `providerModelId: "openai/gpt-5.4-image-2"`, and `originVendor: "openai"`.

## Catalog Entry

`ModelCatalogEntryV1` describes provider model metadata independent from node-specific compatibility. It includes:

- identity: `id`, `provider`, `providerModelId`, `originVendor`
- display: `displayName`, `description`, `iconKey`, `iconPath`
- IO: `inputTypes`, `outputTypes`
- behavior: `capabilities`, `roles`
- runtime availability: `availability`
- generation controls: `parameters`
- economics: `pricing`
- provenance: `catalogStatus`, `aliases`, `metadata`

## Node Options

`ModelOptionForNodeV1` extends `ModelCatalogEntryV1` with node-specific fields:

- `nodeType`
- `storedModelId`
- `executionProvider`
- `compatibilityReason`

Provider-native nodes must use provider-native `storedModelId` values. Unified ids such as `polza:openai/gpt-5.4-image-2` must not be stored unless that exact value is accepted by the executor.

## Merge Rules

Live provider catalogs provide availability. Curated metadata overlays live entries by `{ provider, providerModelId }`, with aliases used only for legacy logical ids.

Unknown live models may appear when provider-normalized metadata proves compatibility. Unknown models must not be guessed into text, image, or video categories from UI name regexes.

## Pricing

Pricing attaches by `{ provider, providerModelId }`. Pricing status can be `fresh`, `stale`, `missing`, or `unknown`, with source information such as provider cache or manual catalog estimate.

## Icons

Icons attach through `iconKey` and `iconPath`. Selection precedence should be:

1. curated model icon
2. curated origin/vendor icon
3. provider icon
4. `unknown`

UI code should render the returned icon path rather than infer icons from model names.

## Parameters

Parameters belong in the catalog merge layer, scoped by provider and capability. Existing selector constants and `livingCanvasModelMetadata` should migrate into V1 in later PRs.

## Future Endpoints

- `GET /api/models`: merged live and curated model catalog.
- `GET /api/models/for-node/:nodeType`: only models compatible with a node, including node-specific `storedModelId` and `executionProvider`.

All selectors should eventually consume `/api/models/for-node/:nodeType`.
