# Model Catalog V1

Model Catalog V1 is the planned single source of truth for model metadata across server, Studio, SnarkRoute, provider adapters, icons, parameters, pricing, and node selectors.

This document describes the V1 catalog surface now used by server model selectors and billing pricing. Existing `/api/models` behavior remains compatible while pricing moves toward Model Catalog as the source of truth.

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
- `providerNativeModelId` is the exact provider-native model id when it differs from the stored model id.
- `originVendor` is the underlying model vendor, such as `openai`, `google`, `qwen`, or `topaz`.
- `canonicalModelId` identifies the portable model concept shared by multiple provider offerings.

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

Pricing is split into three layers:

- `CanonicalModelV1`: portable model identity with vendor, display name, family, capabilities, IO types, and metadata.
- `ProviderModelOfferingV1`: provider-specific offering with provider, provider model id, provider-native model id, operation, availability, capabilities, parameter schema, and last seen time.
- `ProviderModelPricingV1`: price snapshot for an offering/provider/operation/model/params with `providerCostMicrousd`, `baseCredits`, source, confidence, `fetchedAt`, `staleAfter`, notes, and sanitized raw provider pricing.

Pricing lookup uses canonical model id, provider, provider model id/provider-native model id, operation, and price-affecting params. Exact matches win; provider+operation fallback is allowed only when marked `fallback_estimate` with low confidence. Manual catalog and manual initial estimates must not be overwritten by fallback refreshes.

Seed pricing lives in `packages/model-catalog/src/v1/pricing.ts`. Server pricing refresh merges live/cache provider pricing ahead of seed estimates and passes the effective catalog to the executor. The executor applies markup and max-charge caps; it is not the source of model/provider prices.

Run estimates and provider usage persist `pricingSnapshotId` or the full pricing breakdown so later refreshes do not change the price of an already reserved run.

Refresh endpoints:

- `POST /api/model-pricing/refresh`
- `POST /api/admin/pricing/refresh`

Scheduled cloud refresh is controlled by `MODEL_PRICING_REFRESH_ENABLED`, `MODEL_PRICING_REFRESH_CRON`, and `MODEL_PRICING_REFRESH_ON_STARTUP`. The same daily scheduler refreshes the shared RUB/USD cache from CBR for RUB-denominated provider pricing; `BOOJUM_RUB_PER_USD` is only an explicit fallback when live/cache FX is unavailable.

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
- `GET /api/admin/pricing/catalog`: effective pricing table with canonical/provider-native ids, freshness, source, and markup.

All selectors should eventually consume `/api/models/for-node/:nodeType`.
