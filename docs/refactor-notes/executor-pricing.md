# Executor Pricing Refactor Plan

Status: staged plan after the first architecture cleanup pass.

`packages/executor/src/index.ts` mixes:

- public executor and result types
- route execution orchestration
- compound/capability provider execution
- estimate and actual cost calculation
- billing pricing catalog/config/override helpers
- provider usage normalization
- template resolution and dependency validation

Safe staged path:

1. Move public types (`NodeRunner`, `NodeRunnerResult`, `RunResult`, `CostEstimate`, `PricingBreakdown`, provider usage types) into `packages/executor/src/types.ts`, then re-export them from `index.ts`.
2. Move pricing constants and catalog helpers into `packages/executor/src/pricing.ts`:
   - `CREDIT_UNIT`
   - `PROVIDER_PRICING_CATALOG`
   - `currentRuntimeProviderPricingCatalog`
   - `currentBillingPricingConfig`
   - `currentBillingPricingOverrides`
   - `pricingCatalogView`
   - `priceNode`
   - catalog/override normalization helpers
3. Move actual usage/billing summary helpers into `packages/executor/src/billing.ts`:
   - `actualNodeCost`
   - `finalizeRunCostSummary`
   - provider success/failure artifact checks
   - provider usage normalization and redaction
4. Keep `DEFAULT_NODE_COST_MODEL` exported from `index.ts` until downstream imports can be updated deliberately.
5. After each stage, run:
   - `corepack pnpm --filter @snarkroute/executor test`
   - `corepack pnpm --filter @snarkroute/executor build`
   - `corepack pnpm --filter @snarkroute/server test`
   - `corepack pnpm --filter @snarkroute/server build`

Guardrails:

- Do not change credit math, markup precedence, or no-charge provider failure behavior during extraction.
- Keep provider usage events secret-redacted before persistence.
- Preserve exported names from `@snarkroute/executor` until a migration is explicitly planned.
