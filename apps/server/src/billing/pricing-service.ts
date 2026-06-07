import {
  currentBillingPricingConfig,
  currentBillingPricingOverrides,
  pricingCatalogView,
  type BillingPricingConfig,
  type BillingPricingOverride,
  type ProviderPricingCatalogEntry
} from "@snarkroute/executor";
import { readPolzaPricingCatalogCache } from "@snarkroute/polza";
import { getCloudStorage } from "../services/cloud-storage";
import { appMode } from "../services/env";
import { polzaPricingCachePath } from "../server-paths";

export type EffectivePricingState = {
  config: BillingPricingConfig;
  overrides: BillingPricingOverride[];
  providerCatalog: ProviderPricingCatalogEntry[];
  source: "db" | "env_default" | "seed";
  creditUnit: { creditsPerUsd: 1000; microusdPerCredit: 1000 };
};

let cachedState: EffectivePricingState | null = null;

export async function getEffectivePricingState(): Promise<EffectivePricingState> {
  if (cachedState) return cachedState;
  const storage = canReadPricingDatabase() ? getCloudStorage() : null;
  const dbConfig = storage ? await storage.getBillingPricingConfig() : null;
  const dbOverrides = storage ? await storage.listBillingPricingOverrides() : [];
  const envOverrides = currentBillingPricingOverrides();
  const providerCatalog = await runtimeProviderPricingCatalog();
  const config = dbConfig ? {
    globalMarkupPercent: dbConfig.globalMarkupPercent,
    globalMarkupCredits: dbConfig.globalMarkupCredits,
    minChargeCredits: dbConfig.minChargeCredits,
    roundingMode: "ceil" as const,
    updatedAt: dbConfig.updatedAt,
    updatedBy: dbConfig.updatedBy ?? undefined
  } : currentBillingPricingConfig();
  const overrides = dbOverrides.length > 0
    ? dbOverrides.map((override) => ({
      provider: override.provider ?? undefined,
      operation: override.operation ?? undefined,
      model: override.model ?? undefined,
      nodeType: override.nodeType ?? undefined,
      markupPercent: override.markupPercent,
      markupCredits: override.markupCredits,
      enabled: override.enabled,
      reason: override.reason ?? undefined,
      updatedAt: override.updatedAt,
      updatedBy: override.updatedBy ?? undefined
    }))
    : envOverrides;
  cachedState = {
    config,
    overrides,
    providerCatalog,
    source: dbConfig ? "db" : envOverrides.length > 0 ? "seed" : "env_default",
    creditUnit: { creditsPerUsd: 1000, microusdPerCredit: 1000 }
  };
  applyPricingStateToProcess(cachedState);
  return cachedState;
}

export async function pricingCatalogState(): Promise<EffectivePricingState & { pricing: ReturnType<typeof pricingCatalogView> }> {
  const state = await getEffectivePricingState();
  return { ...state, pricing: pricingCatalogView(state.config, state.overrides) };
}

export async function savePricingConfig(input: { globalMarkupPercent: number; globalMarkupCredits: number; minChargeCredits: number; actorUserId: string; reason?: string | null }): Promise<EffectivePricingState> {
  if (![input.globalMarkupPercent, input.globalMarkupCredits, input.minChargeCredits].every(Number.isFinite)) throw new Error("Pricing config values must be numeric.");
  if (input.globalMarkupPercent < 0 || input.globalMarkupCredits < 0 || input.minChargeCredits < 0) throw new Error("Pricing config values cannot be negative.");
  const storage = getCloudStorage();
  const oldValue = await getEffectivePricingState();
  const saved = await storage.upsertBillingPricingConfig({
    globalMarkupPercent: input.globalMarkupPercent,
    globalMarkupCredits: input.globalMarkupCredits,
    minChargeCredits: input.minChargeCredits,
    updatedBy: input.actorUserId
  });
  invalidatePricingCache();
  const nextValue = await getEffectivePricingState();
  await storage.writeAuditEvent({
    actorUserId: input.actorUserId,
    eventType: "admin_pricing_config_update",
    metadata: { oldValue: oldValue.config, newValue: saved, reason: input.reason ?? null }
  });
  return nextValue;
}

export async function savePricingOverride(input: {
  provider?: string | null;
  operation?: string | null;
  model?: string | null;
  nodeType?: string | null;
  markupPercent: number;
  markupCredits: number;
  enabled: boolean;
  reason?: string | null;
  actorUserId: string;
}): Promise<EffectivePricingState> {
  if (![input.markupPercent, input.markupCredits].every(Number.isFinite)) throw new Error("Pricing override values must be numeric.");
  if (input.markupPercent < 0 || input.markupCredits < 0) throw new Error("Pricing override values cannot be negative.");
  const storage = getCloudStorage();
  const oldValue = await getEffectivePricingState();
  const saved = await storage.upsertBillingPricingOverride({ ...input, updatedBy: input.actorUserId });
  invalidatePricingCache();
  const nextValue = await getEffectivePricingState();
  await storage.writeAuditEvent({
    actorUserId: input.actorUserId,
    eventType: "admin_pricing_override_update",
    metadata: { oldValue: oldValue.overrides, newValue: saved, reason: input.reason ?? null }
  });
  return nextValue;
}

export function invalidatePricingCache(): void {
  cachedState = null;
}

function applyPricingStateToProcess(state: EffectivePricingState): void {
  process.env.BOOJUM_GLOBAL_MARKUP_PERCENT = String(state.config.globalMarkupPercent);
  process.env.BOOJUM_GLOBAL_MARKUP_CREDITS = String(state.config.globalMarkupCredits);
  process.env.BOOJUM_MIN_CHARGE_CREDITS = String(state.config.minChargeCredits);
  process.env.BOOJUM_PRICING_UPDATED_AT = state.config.updatedAt ?? "";
  process.env.BOOJUM_PRICING_UPDATED_BY = state.config.updatedBy ?? "";
  process.env.BOOJUM_PRICING_OVERRIDES_JSON = JSON.stringify(state.overrides);
  process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON = JSON.stringify(state.providerCatalog);
}

function canReadPricingDatabase(): boolean {
  return appMode() === "cloud" && Boolean(process.env.DATABASE_URL?.trim());
}

async function runtimeProviderPricingCatalog(): Promise<ProviderPricingCatalogEntry[]> {
  const entries: ProviderPricingCatalogEntry[] = [];
  const polzaCatalog = await readPolzaPricingCatalogCache(polzaPricingCachePath).catch(() => null);
  entries.push(...pricingEntriesFromPolzaCatalog(polzaCatalog));
  return entries;
}

function pricingEntriesFromPolzaCatalog(catalog: unknown): ProviderPricingCatalogEntry[] {
  if (!catalog || typeof catalog !== "object") return [];
  const record = catalog as Record<string, unknown>;
  const models = record.models && typeof record.models === "object" ? record.models as Record<string, unknown> : {};
  const fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : "";
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : "";
  const source = typeof record.source === "string" ? record.source : "polza_models_catalog";
  if (!catalog) return [];
  const entries: ProviderPricingCatalogEntry[] = [];
  for (const [model, item] of Object.entries(models)) {
    if (!item || typeof item !== "object") continue;
    const modelRecord = item as Record<string, unknown>;
    const pricing = modelRecord.pricing && typeof modelRecord.pricing === "object" ? modelRecord.pricing as Record<string, unknown> : {};
    const currency = String(modelRecord.currency ?? pricing.currency ?? "").toUpperCase();
    const tierEntries = polzaTierEntries(model, String(modelRecord.raw && typeof modelRecord.raw === "object" ? (modelRecord.raw as Record<string, unknown>).type ?? "" : ""), pricing, currency, { fetchedAt, expiresAt, source });
    if (tierEntries.length > 0) {
      entries.push(...tierEntries);
      continue;
    }
    const imageCost = unitCostUsd(pricing.image, currency) ?? unitCostUsd(pricing.request, currency);
    if (imageCost !== null) entries.push(polzaCatalogEntry(model, "image.generate", imageCost, { fetchedAt, expiresAt, source }));
    const videoCost = unitCostUsd(pricing.video, currency) ?? unitCostUsd(pricing.request, currency);
    if (videoCost !== null) entries.push(polzaCatalogEntry(model, "video.generate", videoCost, { fetchedAt, expiresAt, source }));
  }
  return entries;
}

function polzaCatalogEntry(model: string, operation: string, usdCost: number, catalog: { fetchedAt?: string; expiresAt?: string; source?: string }): ProviderPricingCatalogEntry {
  return {
    provider: "polza",
    operation,
    model,
    baseCostMicrousd: Math.ceil(usdCost * 1_000_000),
    currency: "USD",
    effectiveFrom: catalog.fetchedAt || new Date(0).toISOString(),
    source: catalog.source || "polza_models_catalog",
    notes: catalog.expiresAt ? `Polza model pricing cache, expires ${catalog.expiresAt}.` : "Polza model pricing cache."
  };
}

function polzaTierEntries(model: string, modelType: string, pricing: Record<string, unknown>, currency: string, catalog: { fetchedAt?: string; expiresAt?: string; source?: string }): ProviderPricingCatalogEntry[] {
  if (!Array.isArray(pricing.tiers)) return [];
  const operation = /video/i.test(modelType) ? "video.generate" : "image.generate";
  const entries: ProviderPricingCatalogEntry[] = [];
  for (const tier of pricing.tiers) {
    if (!tier || typeof tier !== "object") continue;
    const tierRecord = tier as Record<string, unknown>;
    const usdCost = unitCostUsd(tierRecord.cost_usd ?? tierRecord.cost, "USD") ?? unitCostUsd(tierRecord.cost_rub, "RUB") ?? unitCostUsd(tierRecord.cost, currency);
    if (usdCost === null) continue;
    entries.push({
      ...polzaCatalogEntry(model, operation, usdCost, catalog),
      parameterRules: pricingRulesFromConditions(tierRecord.conditions)
    });
  }
  return entries;
}

function pricingRulesFromConditions(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: Record<string, unknown> = {};
  for (const item of value) {
    if (typeof item !== "string") continue;
    const [key, ...rest] = item.split("=");
    const normalizedKey = key.trim();
    const normalizedValue = rest.join("=").trim();
    if (normalizedKey && normalizedValue) rules[normalizedKey] = normalizedValue;
  }
  return Object.keys(rules).length > 0 ? rules : undefined;
}

function unitCostUsd(value: unknown, currency: string): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const normalizedCurrency = currency.toUpperCase();
  if (!normalizedCurrency || normalizedCurrency === "USD") return number;
  if (normalizedCurrency === "RUB") return number / rubPerUsd();
  return null;
}

function rubPerUsd(): number {
  const value = Number(process.env.BOOJUM_RUB_PER_USD ?? 100);
  return Number.isFinite(value) && value > 0 ? value : 100;
}
