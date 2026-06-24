# Boojum Cloud Billing Design

## Current Audit

1. `estimatedCredits` is calculated in `packages/executor/src/index.ts` by `estimateRouteCost()` and `DEFAULT_NODE_COST_MODEL.estimateNode()`. Server routes call it through `CloudCreditBillingAdapter.estimateRunCost()`.
2. `actualCredits` is set in the executor after each node run by `actualNodeCost()` and is persisted from `apps/server/src/routes/execution.ts` into `node_runs.actual_credits`.
3. `credit_transactions` are created in `packages/storage/src/cloud-postgres.ts` by starting grants, reservations, captures, releases/refunds, admin grants, and adjustments.
4. `provider_usage_events` are written by `saveProviderUsageEventsForNodeResult()` in `apps/server/src/routes/execution.ts`, using provider usage returned by node runners or the node estimate fallback.
5. Balance is stored in `credit_accounts.balance_minor`. Boojum credits are treated as integer units even though the column name still says `minor`.
6. Negative balance is blocked by application checks and the `credit_accounts_non_negative_balance` database constraint.
7. The old reserve flow checked balance and updated balance in separate statements, so two concurrent runs could overspend. The MVP flow locks the credit account row inside one DB transaction before inserting the reservation and changing balance.
8. Provider errors produce failed node results. Failed nodes without recorded actual usage now charge `0`; the run billing commit captures only actual successful credits and releases the unused reservation.
9. Explicit run cancellation is not implemented yet. Partial failure is handled by charging only completed provider work and releasing unused reserved credits.
10. Free nodes are `input.*`, `asset.*`, `preview.*`, `output.*`, `debug.*`, `utility.*`, `library.*`, `compound.*`, `text.promptCompose`, and `text.static`.
11. Provider-node base prices now come from Model Catalog provider pricing. `packages/executor` applies markup and fallback behavior, but no longer owns the seeded provider pricing catalog.
12. Before this pass, prices were mostly heuristic in `nodeCostKind()` plus provider cost metadata in adapters. The MVP now maps Model Catalog/provider cache API cost in micro-USD to integer credits, then applies configured markup.

## Current Schema

- `credit_accounts`: one row per user/currency with integer `balance_minor`.
- `credit_transactions`: append-only ledger. Reservations are negative rows, captures are zero-amount audit rows, releases/refunds/grants/adjustments are correcting rows.
- `provider_usage_events`: one row per paid provider call or provider-estimate fallback. It stores node, provider, model, operation, status, estimated/actual credits, usage source, provider cost metadata, and sanitized pricing metadata.
- `canonical_models`, `provider_model_offerings`, `provider_model_pricing`: durable Model Catalog pricing tables for canonical models, provider-specific availability/ids, and pricing snapshots/history.
- `node_runs`: stores per-node estimated and actual credits for run inspection.
- `runs`: stores run status, sanitized inputs/outputs, and errors.

## Problems Found

- The previous reserve implementation was vulnerable to concurrent overspend.
- `commitCredits()` mutated the original reserve row, which violated immutable-ledger expectations.
- Failed nodes could fall back to estimated credits as actual credits.
- Starting grants used a non-target transaction type, `grant_start`.
- The public docs and admin API did not expose enough ledger/balance operations.
- There is still no explicit cancellation flow, no external payment integration, and no durable guest budget table.

## MVP Target

Credits are integer-only. All credit arithmetic rounds up to whole credits and balance is stored as an integer.

Credit unit:

- `1000 credits = 1 USD`
- `1 credit = 0.001 USD`
- Provider API costs are represented as integer `providerCostMicrousd`.
- `baseCredits = ceil(providerCostMicrousd / 1000)`.

Pricing formula:

```text
nodePercentMarkupCredits = ceil(baseCredits * nodeMarkupPercent / 100)
globalPercentMarkupCredits = ceil(baseCredits * globalMarkupPercent / 100)

markupCredits =
  nodePercentMarkupCredits
  + nodeMarkupCredits
  + globalPercentMarkupCredits
  + globalMarkupCredits

finalCredits = max(minChargeCredits, baseCredits + markupCredits)
maxChargeCredits = finalCredits
```

All formula outputs are integers and `finalCredits >= 0`. Actual capture must never exceed `maxChargeCredits` unless a later explicit overage policy is added.

Pricing source priority:

1. Provider actual billing/cost metadata, when the provider returns trustworthy cost or usage.
2. Provider pricing catalog, when actual cost is not returned.
3. Fallback estimate, marked `pricingConfidence=low`.

Pricing catalog entries originate from Model Catalog provider pricing and include provider, operation, optional model, provider-native model id, canonical model id, parameter rules, `baseCostMicrousd`, `currency=USD`, effective date, source, freshness, snapshot id, and notes. Current Polza image seed values keep the old `40 credits` estimate as `baseCostMicrousd=40000`, `source=manual_initial_estimate`, until exact provider billing metadata is available.

Markup levels:

- Global percent markup for all paid nodes.
- Global absolute markup credits for all paid nodes.
- Per-provider/operation/model/node percent markup overrides.
- Per-provider/operation/model/node absolute markup credit overrides.

Durable pricing config:

- `billing_pricing_config` stores the singleton global pricing config in Postgres.
- `billing_pricing_overrides` stores per-provider/operation/model/node overrides in Postgres.
- DB config has priority over env defaults.
- `BOOJUM_PRICING_OVERRIDES_JSON` remains a seed/dev fallback when the DB has no overrides.
- Model Catalog seed pricing and provider model pricing caches are part of the effective catalog. Polza pricing refresh reads `/v1/models` pricing metadata, stores it in `data/cache/model-pricing/polza.json`, and exposes USD model-specific base prices to route estimates before seed estimates are used. OpenRouter pricing refresh uses live pricing when available or cached model catalog pricing as a fallback.
- Polza model pricing can be tiered and RUB-denominated. For MVP conversion to credits, RUB provider costs are converted to USD microusd through `BOOJUM_RUB_PER_USD` (default `100`) before applying markup. Example: 4 RUB at 100 RUB/USD becomes 40 base credits.
- The server keeps an in-memory effective pricing cache; admin saves invalidate and refresh it.
- `POST /api/model-pricing/refresh` and `POST /api/admin/pricing/refresh` invalidate the pricing cache after a successful refresh, so new model prices affect estimates without a server restart.
- Optional daily refresh is controlled by `MODEL_PRICING_REFRESH_ENABLED`, `MODEL_PRICING_REFRESH_CRON`, and `MODEL_PRICING_REFRESH_ON_STARTUP`. In cloud mode with Postgres, refresh runs under a database advisory lock plus an in-process guard.
- Every pricing config or override change writes an `audit_events` row with actor, old value, new value, and reason.

The ledger is immutable. `credit_transactions` must not be updated or deleted after insertion; corrections are new transactions.

Supported transaction types:

- `grant`
- `reserve`
- `capture`
- `release`
- `refund`
- `adjustment`
- `demo_grant`
- `expired`
- `purchase_placeholder`

Run billing flow:

1. Preflight estimate via `GET/POST` estimate APIs.
2. Check and reserve estimated credits before provider execution.
3. Execute providers.
4. Record `provider_usage_events` for paid provider calls.
5. Capture actual credits after success or partial failure.
6. Release unused reservation on safe failure.
7. Never charge more than reserved `maxChargeCredits`; overage requires a later explicit transaction.
8. Return `estimatedCredits`, `reservedCredits`, `actualCredits`, `refundedCredits`, and `balanceAfter` in the run billing summary.

Paid node families:

- provider image generation
- provider video generation
- provider upscaling
- provider text/audio calls when enabled

Model Catalog pricing examples:

- `polza.image.generate`: generic fallback `baseCostMicrousd=40000`, `baseCredits=40`; real Polza model rows should come from the refreshed Polza model pricing cache or model-specific admin overrides.
- `polza.video.generate`: generic fallback `baseCostMicrousd=80000`, `baseCredits=80`; real Polza model rows should come from the refreshed Polza model pricing cache or model-specific admin overrides.
- `replicate.clarity-upscaler`: canonical model `replicate/clarity-upscaler`, provider-native id `philz1337x/clarity-upscaler`, `baseCostMicrousd=40000`, `baseCredits=40`
- `openrouter.text.generate`: `baseCostMicrousd=1000`, `baseCredits=1`

User API:

- `GET /api/billing/balance`
- `GET /api/billing/transactions`
- `POST /api/billing/estimate`
- `POST /api/routes/estimate`
- run responses include billing summary fields.

Admin API:

- list user balances
- list credit transactions
- grant credits
- adjust credits
- view provider usage through admin overview
- compare estimated vs actual through node runs and provider usage rows
- view pricing catalog through `GET /api/admin/pricing/catalog`
- view/update in-process global pricing config through `GET/POST /api/admin/pricing/config`
- refresh all/provider pricing through `POST /api/admin/pricing/refresh`

Admin scripts:

- `corepack pnpm run admin:list-users`
- `corepack pnpm run admin:grant-credits -- --user-id <uuid> --amount <int> --reason "<text>"`
- `corepack pnpm run admin:billing-ledger -- --user-id <uuid>`

Admin billing UI:

- `/admin` includes a `Users / Credits` table with user id, role, auth provider summary, current balance, grant/spend/release totals, active reservations, run count, and last activity.
- Selecting a user opens a card with current balance, billing totals, recent runs, recent credit transactions, and recent provider usage.
- `Grant credits` creates a new immutable `grant` transaction through the shared storage billing method.
- `Adjust credits` creates a new immutable `adjustment` transaction through the shared storage billing method; negative adjustments cannot take the balance below zero unless explicitly allowed by admin config.
- The UI does not show email, name, avatar, raw Google/Yandex subject, API keys, provider secrets, or raw provider request subjects. OAuth identity display is limited to provider names and, if needed, a short provider-subject hash prefix.
- Ledger rows remain append-only. Admin UI never edits old `credit_transactions` and never directly updates balance without a matching transaction.

Admin pricing UI:

- `/admin` includes a `Pricing` section.
- It shows the credit unit, global markup percent, global markup credits, and min charge credits.
- It lists provider pricing rows with provider, operation, canonical model, provider-native id, base API cost, base credits, global markup, node markup, final estimated credits, source, fetched time, and stale status.
- Saving global pricing config writes `billing_pricing_config` and an audit event.
- Saving an override writes `billing_pricing_overrides` and an audit event.
- The UI shows whether the effective pricing config came from DB, env defaults, or seed fallback.

User-facing node explanation:

- Paid provider nodes show estimated final credits and balance.
- The info tooltip explains canonical model, provider-native model id, base API credits, global markup, node markup, final credits, source, confidence, freshness, and whether a fallback estimate was used.
- Free nodes show `Free` or no price and do not participate in route totals.

Guest demo:

- Guest runs use demo limits and do not reserve from a real user balance.
- Guest provider usage rows have `user_id = null` and run inputs include `actorType=guest`.
- Guest transactions should use `actorType=guest` or `demo` if/when a durable guest budget table is added.

Safety:

- No negative balance by default.
- Balance changes and ledger insertions happen inside DB transactions.
- Reservation capture is idempotent per reservation.
- Billing/provider usage logs are sanitized.
- Billing tables store user ids and provider-subject hashes only; no email, name, avatar, raw OAuth subject, or secrets.

## Deferred Until Real Payments

- Stripe, YooKassa, invoices, receipts, cards, webhooks, tax, refunds to payment method.
- Purchase fulfillment beyond `purchase_placeholder`.
- Paid plan logic, subscriptions, trials, coupons, VAT, and regional pricing.
- Durable guest-budget accounts.
- Explicit cancellation API with provider-side cancellation semantics.
- Full provider-cost reconciliation against external invoices.

## Smoke Tests To Keep

- User with `100` credits runs a `40` credit route and ends with balance `60`.
- User with `20` credits cannot run a `40` credit route.
- Provider failure before charge releases the reservation.
- Provider success writes `credit_transactions` and `provider_usage_events`.
- Two simultaneous runs cannot overspend balance.
- Admin grant adds credits and writes ledger.
- Guest demo run does not touch real user balance.
