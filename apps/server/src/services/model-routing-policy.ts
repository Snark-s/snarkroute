import type { ModelOptionForNodeV1, ModelPricingInfoV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { appMode } from "./env";

/** Server-local invocation policy; never changes the portable route schema. */
export interface ModelRoutingPolicy {
  allowPaid?: boolean;
  localModels?: "allow" | "exclude";
  /** Owner's flat-rate plans (Claude Code CLI, Codex CLI): no per-request charge, but a usage quota. */
  subscriptionModels?: "allow" | "exclude";
  excludeModelRefs?: string[];
}
export type ModelCostTier = "local" | "subscription" | "free" | "paid_or_unknown";
export const SUBSCRIPTION_PROVIDERS = new Set(["claude_subscription", "chatgpt_subscription"]);

export class ModelRoutingPolicyError extends Error {
  readonly retryable = false;
  readonly origin = "snarkroute";
  readonly details: Record<string, unknown>;
  constructor(readonly code: string, message: string, readonly providerId?: string) {
    super(message);
    this.name = "ModelRoutingPolicyError";
    this.details = { origin: this.origin, ...(providerId ? { providerId } : {}) };
  }
}

export function modelRoutingPolicy(value: unknown): ModelRoutingPolicy {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    allowPaid: record.allowPaid === true,
    localModels: record.localModels === "exclude" ? "exclude" : "allow",
    subscriptionModels: record.subscriptionModels === "exclude" ? "exclude" : "allow",
    excludeModelRefs: Array.isArray(record.excludeModelRefs)
      ? record.excludeModelRefs.filter((ref): ref is string => typeof ref === "string" && Boolean(ref.trim())).slice(0, 64)
      : []
  };
}

export function modelCostTier(provider: string, modelId: string, metadata: Record<string, unknown>, pricing: ModelPricingInfoV1 | undefined, outputs: string[]): ModelCostTier {
  if (provider === "local_openai" || provider === "local_upscale" || provider === "local_video_upscale"
    || provider === "minimax-h3" && metadata.local === true && !["h3_max", "h3_max_turbo"].includes(modelId)) return "local";
  if (SUBSCRIPTION_PROVIDERS.has(provider)) return "subscription";
  if (pricing?.status !== "fresh" || pricing.source === "unknown" || !pricing.pricing
    || pricing.expiresAt && (!Number.isFinite(Date.parse(pricing.expiresAt)) || Date.parse(pricing.expiresAt) <= Date.now())) return "paid_or_unknown";
  const prices = pricing.pricing;
  const entries = Object.values(prices);
  const zero = (value: unknown) => (typeof value === "number" || typeof value === "string" && Boolean(value.trim()))
    && Number.isFinite(Number(value)) && Number(value) === 0;
  // A free prompt price alone says nothing about the generated output charge.
  const complete = zero(prices.request)
    || outputs.includes("text") && zero(prices.prompt) && zero(prices.completion)
    || outputs.includes("image") && zero(prices.image)
    || outputs.includes("video") && zero(prices.video);
  return complete && entries.length > 0 && entries.every(zero) ? "free" : "paid_or_unknown";
}

const depletedProviders = new Map<string, number>();
const balanceFailureTtlMs = 60_000;

export function recordModelProviderFailure(provider: string, error: unknown): void {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (record.errorCode === "provider_insufficient_funds" || record.code === "PROVIDER_INSUFFICIENT_FUNDS") {
    depletedProviders.set(provider, Date.now() + balanceFailureTtlMs);
  }
}

export function providerBalanceUnavailable(provider: string): boolean {
  const until = depletedProviders.get(provider);
  if (until === undefined) return false;
  if (until <= Date.now()) { depletedProviders.delete(provider); return false; }
  return true;
}

/** Credentials and client-supplied pricing never authorize a charge. */
export async function assertModelInvocationPolicy(
  provider: string,
  modelId: string,
  params: Record<string, unknown>,
  nodeType: string,
  loadCatalog?: () => Promise<ModelOptionForNodeV1[]>
): Promise<void> {
  if (appMode() === "cloud") return; // Original hosted billing remains authoritative.
  const policy = modelRoutingPolicy(params.routingPolicy);
  if (providerBalanceUnavailable(provider)) throw new ModelRoutingPolicyError("PROVIDER_BALANCE_UNAVAILABLE", `Provider ${provider} recently rejected a request for insufficient balance. Retry after checking that provider account.`, provider);
  const local = modelCostTier(provider, modelId, {}, undefined, []);
  if (local === "local") {
    if (policy.localModels === "exclude") throw new ModelRoutingPolicyError("LOCAL_MODEL_EXCLUDED", "Local models are excluded for this task.", provider);
    return;
  }
  if (local === "subscription") {
    if (policy.subscriptionModels === "exclude") throw new ModelRoutingPolicyError("SUBSCRIPTION_MODEL_EXCLUDED", "Subscription models are excluded for this task.", provider);
    return; // The adapter itself refuses API keys and paid extra usage.
  }
  if (policy.allowPaid) return;
  const models = loadCatalog ? await loadCatalog() : (await import("./model-catalog-v1")).modelOptionsForNodeV1(nodeType,
    await (await import("../routes/models")).loadLiveModelCatalogV1(nodeType));
  const route = models.flatMap(option => option.providerRoutes?.length ? option.providerRoutes.map(entry => ({
    ...option, provider: entry.provider, providerModelId: entry.providerModelId, availability: entry.availability,
    pricing: entry.pricing, metadata: { ...(option.metadata ?? {}), ...(entry.metadata ?? {}) }, outputTypes: entry.outputTypes
  })) : [option]).find(entry => entry.provider === provider && entry.providerModelId === modelId
    && entry.availability.status === "available" && entry.availability.configured !== false);
  if (route && modelCostTier(provider, modelId, route.metadata ?? {}, route.pricing, route.outputTypes) !== "paid_or_unknown") return;
  throw new ModelRoutingPolicyError("PAID_PERMISSION_REQUIRED", `No confirmed free route is available for ${provider}/${modelId}. Paid or unknown-cost inference requires explicit permission.`, provider);
}
