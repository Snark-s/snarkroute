import {
  currentBillingPricingConfig,
  currentBillingPricingOverrides,
  pricingCatalogView,
  type BillingPricingConfig,
  type BillingPricingOverride,
  type ProviderPricingCatalogEntry
} from "@snarkroute/executor";
import { listSeedProviderPricingCatalogV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { readOpenRouterModelCatalogCache, readOpenRouterPricingCatalogCache } from "@snarkroute/openrouter";
import { readPolzaPricingCatalogCache } from "@snarkroute/polza";
import { listLocalDevProviderPricingActualStats } from "./local-dev-ledger";
import { getCloudStorage } from "../services/cloud-storage";
import { appMode } from "../services/env";
import { openRouterCatalogCachePath, openRouterPricingCachePath, polzaPricingCachePath } from "../server-paths";

export type EffectivePricingState = {
  config: BillingPricingConfig;
  overrides: BillingPricingOverride[];
  providerCatalog: ProviderPricingCatalogEntry[];
  source: "db" | "local_override" | "env_default" | "seed";
  creditUnit: { creditsPerUsd: 1000; microusdPerCredit: 1000 };
};

export type ProviderPricingActualStats = {
  provider: string | null;
  operation: string | null;
  model: string | null;
  pricingSnapshotId?: string | null;
  samples: number;
  avgActualCredits: number | null;
  lastActualCredits: number | null;
  avgProviderCostMicrousd: number | null;
  lastProviderCostMicrousd: number | null;
  lastCreatedAt: string | null;
};

let cachedState: EffectivePricingState | null = null;
let localPricingConfig: (BillingPricingConfig & { updatedAt?: string; updatedBy?: string }) | null = null;
let localPricingOverrides: BillingPricingOverride[] | null = null;

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
  } : localPricingConfig ? {
    ...localPricingConfig,
    roundingMode: "ceil" as const
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
    : localPricingOverrides
      ? localPricingOverrides
    : envOverrides;
  cachedState = {
    config,
    overrides,
    providerCatalog,
    source: dbConfig ? "db" : localPricingConfig || localPricingOverrides ? "local_override" : envOverrides.length > 0 ? "seed" : "env_default",
    creditUnit: { creditsPerUsd: 1000, microusdPerCredit: 1000 }
  };
  applyPricingStateToProcess(cachedState);
  return cachedState;
}

export async function pricingCatalogState(): Promise<EffectivePricingState & { pricing: ReturnType<typeof pricingCatalogView>; actualStats: ProviderPricingActualStats[] }> {
  const state = await getEffectivePricingState();
  const actualStats = canReadPricingDatabase()
    ? await (getCloudStorage() as unknown as { listProviderPricingActualStats: () => Promise<ProviderPricingActualStats[]> }).listProviderPricingActualStats().catch(() => [])
    : listLocalDevProviderPricingActualStats();
  return { ...state, pricing: pricingCatalogView(state.config, state.overrides), actualStats };
}

export async function savePricingConfig(input: { globalMarkupPercent: number; globalMarkupCredits: number; minChargeCredits: number; actorUserId: string; reason?: string | null }): Promise<EffectivePricingState> {
  if (![input.globalMarkupPercent, input.globalMarkupCredits, input.minChargeCredits].every(Number.isFinite)) throw new Error("Pricing config values must be numeric.");
  if (input.globalMarkupPercent < 0 || input.globalMarkupCredits < 0 || input.minChargeCredits < 0) throw new Error("Pricing config values cannot be negative.");
  const oldValue = await getEffectivePricingState();
  if (!canReadPricingDatabase()) {
    localPricingConfig = {
      globalMarkupPercent: input.globalMarkupPercent,
      globalMarkupCredits: input.globalMarkupCredits,
      minChargeCredits: input.minChargeCredits,
      roundingMode: "ceil",
      updatedAt: new Date().toISOString(),
      updatedBy: input.actorUserId
    };
    invalidatePricingCache();
    return await getEffectivePricingState();
  }
  const storage = getCloudStorage();
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
  const oldValue = await getEffectivePricingState();
  if (!canReadPricingDatabase()) {
    const nextOverride: BillingPricingOverride = {
      provider: input.provider ?? undefined,
      operation: input.operation ?? undefined,
      model: input.model ?? undefined,
      nodeType: input.nodeType ?? undefined,
      markupPercent: input.markupPercent,
      markupCredits: input.markupCredits,
      enabled: input.enabled,
      reason: input.reason ?? undefined,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actorUserId
    };
    const key = pricingOverrideKey(nextOverride);
    localPricingOverrides = [
      nextOverride,
      ...(localPricingOverrides ?? []).filter((override) => pricingOverrideKey(override) !== key)
    ];
    invalidatePricingCache();
    return await getEffectivePricingState();
  }
  const storage = getCloudStorage();
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

function pricingOverrideKey(override: BillingPricingOverride): string {
  return [override.provider ?? "*", override.operation ?? "*", override.model ?? "*", override.nodeType ?? "*"].join(":");
}

async function runtimeProviderPricingCatalog(): Promise<ProviderPricingCatalogEntry[]> {
  const entries: ProviderPricingCatalogEntry[] = [];
  const addEntries = (nextEntries: ProviderPricingCatalogEntry[]) => {
    const known = new Set(entries.map(providerPricingEntryKey));
    for (const entry of nextEntries) {
      const key = providerPricingEntryKey(entry);
      if (known.has(key)) continue;
      known.add(key);
      entries.push(entry);
    }
  };
  const polzaCatalog = await readPolzaPricingCatalogCache(polzaPricingCachePath).catch(() => null);
  addEntries(pricingEntriesFromPolzaCatalog(polzaCatalog));
  const openRouterCatalog = await readOpenRouterPricingCatalogCache(openRouterPricingCachePath).catch(() => null);
  addEntries(pricingEntriesFromGenericCatalog(openRouterCatalog, "openrouter"));
  const openRouterModelCatalog = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath).catch(() => null);
  addEntries(pricingEntriesFromOpenRouterModelCatalog(openRouterModelCatalog));
  addEntries(listSeedProviderPricingCatalogV1().map((entry) => ({ ...entry })));
  return entries;
}

function providerPricingEntryKey(entry: ProviderPricingCatalogEntry): string {
  return [entry.provider, entry.operation, entry.model ?? "*", JSON.stringify(entry.parameterRules ?? {})].join(":");
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
    source: catalog.source || "provider_catalog",
    pricingSnapshotId: pricingSnapshotId("polza", operation, model, undefined, catalog.fetchedAt),
    fetchedAt: catalog.fetchedAt,
    staleAfter: catalog.expiresAt,
    notes: catalog.expiresAt ? `Polza model pricing cache, expires ${catalog.expiresAt}.` : "Polza model pricing cache."
  };
}

function pricingEntriesFromGenericCatalog(catalog: unknown, provider: string): ProviderPricingCatalogEntry[] {
  if (!catalog || typeof catalog !== "object") return [];
  const record = catalog as Record<string, unknown>;
  const models = record.models && typeof record.models === "object" ? record.models as Record<string, unknown> : {};
  const fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : "";
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : "";
  const source = typeof record.source === "string" ? record.source : "provider_catalog";
  const entries: ProviderPricingCatalogEntry[] = [];
  for (const [model, item] of Object.entries(models)) {
    if (!item || typeof item !== "object") continue;
    const modelRecord = item as Record<string, unknown>;
    const pricing = modelRecord.pricing && typeof modelRecord.pricing === "object" ? modelRecord.pricing as Record<string, unknown> : {};
    const raw = modelRecord.raw && typeof modelRecord.raw === "object" ? modelRecord.raw as Record<string, unknown> : undefined;
    const currency = String(modelRecord.currency ?? pricing.currency ?? "").toUpperCase();
    const imagePrice = providerSupportsPricingOperation(provider, raw, "image.generate") ? imageGenerateCostUsd(provider, pricing, currency, source) : null;
    if (imagePrice) entries.push(genericCatalogEntry(provider, model, "image.generate", imagePrice.usdCost, { fetchedAt, expiresAt, source: imagePrice.source, notes: imagePrice.notes }));
    const videoCost = providerSupportsPricingOperation(provider, raw, "video.generate") ? unitCostUsd(pricing.video, currency) ?? unitCostUsd(pricing.request, currency) : null;
    if (videoCost !== null) entries.push(genericCatalogEntry(provider, model, "video.generate", videoCost, { fetchedAt, expiresAt, source }));
    const textCost = providerSupportsPricingOperation(provider, raw, "text.generate") ? unitCostUsd(pricing.request, currency) : null;
    if (textCost !== null) entries.push(genericCatalogEntry(provider, model, "text.generate", textCost, { fetchedAt, expiresAt, source }));
  }
  return entries;
}

function providerSupportsPricingOperation(provider: string, raw: Record<string, unknown> | undefined, operation: "image.generate" | "text.generate" | "video.generate"): boolean {
  if (provider !== "openrouter") return true;
  if (!raw) return operation === "text.generate";
  const outputs = openRouterRawOutputModalities(raw);
  if (operation === "image.generate") return outputs.includes("image");
  if (operation === "video.generate") return outputs.includes("video");
  return outputs.length === 0 || outputs.includes("text");
}

function openRouterRawOutputModalities(raw: Record<string, unknown>): string[] {
  const architecture = raw.architecture && typeof raw.architecture === "object" ? raw.architecture as Record<string, unknown> : {};
  const output = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
  const modalities = output.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
  const kind = typeof raw.kind === "string" ? raw.kind.toLowerCase() : "";
  if (kind === "image") modalities.push("image");
  if (kind === "video") modalities.push("video");
  if (kind === "text") modalities.push("text");
  const modality = typeof architecture.modality === "string" ? architecture.modality.toLowerCase() : "";
  if (modality.includes("->")) {
    for (const part of modality.split("->").slice(1).join("+").split("+")) {
      const normalized = part.trim();
      if (normalized) modalities.push(normalized);
    }
  }
  return [...new Set(modalities)];
}

function pricingEntriesFromOpenRouterModelCatalog(catalog: unknown): ProviderPricingCatalogEntry[] {
  if (!catalog || typeof catalog !== "object") return [];
  const record = catalog as Record<string, unknown>;
  const models = Array.isArray(record.models) ? record.models : [];
  const fetchedAt = typeof record.refreshedAt === "string" ? record.refreshedAt : "";
  const fetchedMs = Date.parse(fetchedAt);
  const expiresAt = Number.isFinite(fetchedMs) ? new Date(fetchedMs + 12 * 60 * 60 * 1000).toISOString() : "";
  const pricingCatalog = {
    fetchedAt,
    expiresAt,
    source: "openrouter_models_catalog",
    models: Object.fromEntries(models
      .filter((model): model is Record<string, unknown> => Boolean(model) && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string")
      .map((model) => [model.id as string, { currency: "USD", pricing: model.pricing, raw: model }]))
  };
  return pricingEntriesFromGenericCatalog(pricingCatalog, "openrouter");
}

function genericCatalogEntry(provider: string, model: string, operation: string, usdCost: number, catalog: { fetchedAt?: string; expiresAt?: string; source?: string; notes?: string }): ProviderPricingCatalogEntry {
  return {
    provider,
    operation,
    model,
    baseCostMicrousd: Math.ceil(usdCost * 1_000_000),
    currency: "USD",
    effectiveFrom: catalog.fetchedAt || new Date(0).toISOString(),
    source: catalog.source || "provider_catalog",
    pricingSnapshotId: pricingSnapshotId(provider, operation, model, undefined, catalog.fetchedAt),
    fetchedAt: catalog.fetchedAt,
    staleAfter: catalog.expiresAt,
    notes: catalog.notes ?? (catalog.expiresAt ? `${provider} pricing cache, expires ${catalog.expiresAt}.` : `${provider} pricing cache.`)
  };
}

function imageGenerateCostUsd(provider: string, pricing: Record<string, unknown>, currency: string, source: string): { usdCost: number; source: string; notes?: string } | null {
  if (provider === "openrouter") {
    const tokenEstimate = openRouterImageTokenEstimateUsd(pricing, currency, source);
    if (tokenEstimate) return tokenEstimate;
    const request = unitCostUsd(pricing.request, currency);
    if (request !== null) return { usdCost: request, source };
    const image = unitCostUsd(pricing.image, currency);
    return image !== null ? { usdCost: image, source: `${source}_image_unit`, notes: "OpenRouter image-unit price without token metadata; final provider usage may differ." } : null;
  }
  const exact = unitCostUsd(pricing.image, currency) ?? unitCostUsd(pricing.request, currency);
  return exact !== null ? { usdCost: exact, source } : null;
}

function openRouterImageTokenEstimateUsd(pricing: Record<string, unknown>, currency: string, source: string): { usdCost: number; source: string; notes?: string } | null {
  const prompt = unitCostUsd(pricing.prompt, currency);
  const completion = unitCostUsd(pricing.completion, currency);
  if (prompt === null && completion === null) return null;
  const promptTokens = positiveEnvNumber("BOOJUM_OPENROUTER_IMAGE_PROMPT_TOKEN_ESTIMATE", 1000);
  const outputTokens = positiveEnvNumber("BOOJUM_OPENROUTER_IMAGE_OUTPUT_TOKEN_ESTIMATE", 4096);
  const usdCost = (prompt ?? 0) * promptTokens + (completion ?? 0) * outputTokens;
  if (!Number.isFinite(usdCost) || usdCost <= 0) return null;
  return {
    usdCost,
    source: `${source}_token_estimate`,
    notes: `OpenRouter token-priced image estimate using ${promptTokens} prompt tokens and ${outputTokens} output tokens; final provider usage may differ.`
  };
}

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
    const parameterRules = pricingRulesFromConditions(tierRecord.conditions);
    entries.push({
      ...polzaCatalogEntry(model, operation, usdCost, catalog),
      parameterRules,
      pricingSnapshotId: pricingSnapshotId("polza", operation, model, parameterRules, catalog.fetchedAt)
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

export const __testing = {
  pricingEntriesFromGenericCatalog,
  pricingEntriesFromOpenRouterModelCatalog,
  resetLocalPricingState: () => {
    localPricingConfig = null;
    localPricingOverrides = null;
    invalidatePricingCache();
  }
};

function pricingSnapshotId(provider: string, operation: string, model: string | undefined, params: Record<string, unknown> | undefined, fetchedAt: string | undefined): string {
  const suffix = params && Object.keys(params).length ? `:${JSON.stringify(params)}` : "";
  return `${provider}:${operation}:${model ?? "*"}:${fetchedAt || "unknown"}${suffix}`;
}
