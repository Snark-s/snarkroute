import type { ModelCapabilityV1, ModelInputTypeV1, ModelOutputTypeV1, ModelProviderIdV1 } from "./types.js";

export type CanonicalModelV1 = {
  id: string;
  vendor: string;
  displayName: string;
  family?: string;
  capabilities: ModelCapabilityV1[];
  inputTypes: ModelInputTypeV1[];
  outputTypes: ModelOutputTypeV1[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type ProviderModelOfferingV1 = {
  id: string;
  canonicalModelId?: string;
  provider: ModelProviderIdV1;
  providerModelId: string;
  providerNativeModelId?: string;
  operation: ModelCapabilityV1 | string;
  available: boolean;
  availabilitySource: "live" | "cache" | "curated" | "fallback" | "manual";
  capabilities: ModelCapabilityV1[];
  parameterSchema?: Record<string, unknown>;
  lastSeenAt?: string;
  updatedAt?: string;
};

export type ProviderModelPricingV1 = {
  id: string;
  offeringId?: string;
  provider: ModelProviderIdV1;
  canonicalModelId?: string;
  providerModelId?: string;
  providerNativeModelId?: string;
  operation: ModelCapabilityV1 | string;
  priceUnit: "request" | "image" | "video" | "token" | "second" | "unknown";
  currency: "USD";
  providerCostMicrousd: number;
  baseCredits: number;
  pricingSource: "provider_api" | "provider_catalog" | "manual_catalog" | "manual_initial_estimate" | "fallback_estimate";
  pricingConfidence: "high" | "medium" | "low";
  priceParams?: Record<string, unknown>;
  effectiveFrom: string;
  fetchedAt?: string;
  staleAfter?: string;
  notes?: string;
  rawProviderPricing?: Record<string, unknown>;
};

export type ProviderPricingCatalogEntryV1 = {
  provider: string;
  model?: string;
  operation: string;
  parameterRules?: Record<string, unknown>;
  baseCostMicrousd: number;
  currency: "USD";
  effectiveFrom: string;
  source: string;
  notes?: string;
  canonicalModelId?: string;
  providerModelId?: string;
  providerNativeModelId?: string;
  pricingSnapshotId?: string;
  fetchedAt?: string;
  staleAfter?: string;
  fallback?: boolean;
};

const seededCanonicalModels: CanonicalModelV1[] = [
  {
    id: "google/nano-banana-2",
    vendor: "google",
    displayName: "Nano Banana 2",
    family: "nano-banana",
    capabilities: ["image.generate"],
    inputTypes: ["text", "image"],
    outputTypes: ["image"]
  },
  {
    id: "replicate/clarity-upscaler",
    vendor: "replicate",
    displayName: "Clarity Upscaler",
    family: "clarity",
    capabilities: ["image.upscale"],
    inputTypes: ["image", "text"],
    outputTypes: ["image"]
  }
];

const seededProviderOfferings: ProviderModelOfferingV1[] = [
  {
    id: "replicate:clarity-upscaler:image.upscale",
    canonicalModelId: "replicate/clarity-upscaler",
    provider: "replicate",
    providerModelId: "clarity-upscaler",
    providerNativeModelId: "philz1337x/clarity-upscaler",
    operation: "image.upscale",
    available: true,
    availabilitySource: "manual",
    capabilities: ["image.upscale"]
  },
  {
    id: "polza:gpt-5.4-image-2:image.generate",
    provider: "polza",
    providerModelId: "gpt-5.4-image-2",
    providerNativeModelId: "openai/gpt-5.4-image-2",
    operation: "image.generate",
    available: true,
    availabilitySource: "manual",
    capabilities: ["image.generate"]
  }
];

const seededProviderPricing: ProviderModelPricingV1[] = [
  seededPrice({
    id: "polza:gpt-5.4-image-2:image.generate:resolution=1K",
    offeringId: "polza:gpt-5.4-image-2:image.generate",
    provider: "polza",
    providerModelId: "gpt-5.4-image-2",
    providerNativeModelId: "openai/gpt-5.4-image-2",
    operation: "image.generate",
    providerCostMicrousd: 40000,
    priceParams: { resolution: "1K" },
    notes: "Temporary until provider exact billing metadata is available."
  }),
  seededPrice({
    id: "replicate:clarity-upscaler:image.upscale",
    offeringId: "replicate:clarity-upscaler:image.upscale",
    canonicalModelId: "replicate/clarity-upscaler",
    provider: "replicate",
    providerModelId: "clarity-upscaler",
    providerNativeModelId: "philz1337x/clarity-upscaler",
    operation: "image.upscale",
    providerCostMicrousd: 21000,
    pricingSource: "manual_catalog",
    pricingConfidence: "medium",
    notes: "Replicate public model page says this model costs approximately $0.021/run and varies with inputs; capture actual usage when provider billing metadata is integrated.",
    rawProviderPricing: { publicEstimateUsd: 0.021, sourceUrl: "https://replicate.com/philz1337x/clarity-upscaler" }
  }),
  ...[
    ["1K", 67000],
    ["2K", 101000],
    ["4K", 151000]
  ].map(([resolution, microusd]) => seededPrice({
    id: `gemini:gemini-3.1-flash-image-preview:image.generate:resolution=${resolution}`,
    canonicalModelId: "google/nano-banana-2",
    provider: "gemini",
    providerModelId: "gemini-3.1-flash-image-preview",
    operation: "image.generate",
    providerCostMicrousd: Number(microusd),
    priceUnit: "image",
    priceParams: { image_resolution: resolution },
    pricingSource: "manual_catalog",
    pricingConfidence: "high",
    notes: "Gemini API pricing: Gemini 3.1 Flash Image output image price by resolution.",
    rawProviderPricing: { sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing", resolution }
  })),
  ...[
    ["1K", 134000],
    ["2K", 134000],
    ["4K", 240000]
  ].map(([resolution, microusd]) => seededPrice({
    id: `gemini:gemini-3-pro-image:image.generate:resolution=${resolution}`,
    provider: "gemini",
    providerModelId: "gemini-3-pro-image",
    operation: "image.generate",
    providerCostMicrousd: Number(microusd),
    priceUnit: "image",
    priceParams: { image_resolution: resolution },
    pricingSource: "manual_catalog",
    pricingConfidence: "high",
    notes: "Gemini API pricing: Gemini 3 Pro Image output image price by resolution.",
    rawProviderPricing: { sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing", resolution }
  })),
  seededFallbackPrice({ id: "replicate:*:image.generate", provider: "replicate", operation: "image.generate", providerCostMicrousd: 40000, notes: "Low-confidence provider fallback. Replicate pricing is model/hardware/input dependent; use model-specific catalog or actual provider usage when available." }),
  seededFallbackPrice({ id: "gemini:*:image.generate", provider: "gemini", operation: "image.generate", providerCostMicrousd: 40000, notes: "Low-confidence fallback for Gemini image models without model/resolution-specific pricing." }),
  seededFallbackPrice({ id: "gemini:*:text.generate", provider: "gemini", operation: "text.generate", providerCostMicrousd: 1000, notes: "Low-confidence fallback. Gemini text pricing is token/model dependent." }),
  seededFallbackPrice({ id: "openrouter:*:image.generate", provider: "openrouter", operation: "image.generate", providerCostMicrousd: 40000, notes: "Low-confidence fallback. OpenRouter prices vary by model; refresh OpenRouter pricing for model-specific estimates." }),
  seededFallbackPrice({ id: "openrouter:*:text.generate", provider: "openrouter", operation: "text.generate", providerCostMicrousd: 1000, notes: "Low-confidence fallback. OpenRouter text prices vary by model/token usage." }),
  seededFallbackPrice({ id: "seedance:*:video.generate", provider: "seedance", operation: "video.generate", providerCostMicrousd: 80000, notes: "Low-confidence fallback. Seedance pricing depends on model, duration, resolution, and provider route." })
];

export function listSeedCanonicalModelsV1(): CanonicalModelV1[] {
  return seededCanonicalModels.map((entry) => ({ ...entry, capabilities: [...entry.capabilities], inputTypes: [...entry.inputTypes], outputTypes: [...entry.outputTypes], metadata: cloneRecord(entry.metadata) }));
}

export function listSeedProviderOfferingsV1(): ProviderModelOfferingV1[] {
  return seededProviderOfferings.map((entry) => ({ ...entry, capabilities: [...entry.capabilities], parameterSchema: cloneRecord(entry.parameterSchema) }));
}

export function listSeedProviderPricingV1(): ProviderModelPricingV1[] {
  return seededProviderPricing.map((entry) => ({ ...entry, priceParams: cloneRecord(entry.priceParams), rawProviderPricing: cloneRecord(entry.rawProviderPricing) }));
}

export function listSeedProviderPricingCatalogV1(): ProviderPricingCatalogEntryV1[] {
  return listSeedProviderPricingV1().map(providerPricingToCatalogEntryV1);
}

export function providerPricingToCatalogEntryV1(pricing: ProviderModelPricingV1): ProviderPricingCatalogEntryV1 {
  return {
    provider: pricing.provider,
    operation: pricing.operation,
    model: pricing.providerModelId === "*" ? undefined : pricing.providerModelId,
    parameterRules: pricing.priceParams,
    baseCostMicrousd: pricing.providerCostMicrousd,
    currency: pricing.currency,
    effectiveFrom: pricing.effectiveFrom,
    source: pricing.pricingSource,
    notes: pricing.notes,
    canonicalModelId: pricing.canonicalModelId,
    providerModelId: pricing.providerModelId,
    providerNativeModelId: pricing.providerNativeModelId,
    pricingSnapshotId: pricing.id,
    fetchedAt: pricing.fetchedAt,
    staleAfter: pricing.staleAfter,
    fallback: pricing.pricingSource === "fallback_estimate" || pricing.providerModelId === undefined || pricing.providerModelId === "*"
  };
}

function seededPrice(input: {
  id: string;
  offeringId?: string;
  canonicalModelId?: string;
  provider: ModelProviderIdV1;
  providerModelId?: string;
  providerNativeModelId?: string;
  operation: string;
  priceUnit?: ProviderModelPricingV1["priceUnit"];
  providerCostMicrousd: number;
  pricingSource?: ProviderModelPricingV1["pricingSource"];
  pricingConfidence?: ProviderModelPricingV1["pricingConfidence"];
  priceParams?: Record<string, unknown>;
  notes?: string;
  rawProviderPricing?: Record<string, unknown>;
}): ProviderModelPricingV1 {
  return {
    ...input,
    priceUnit: input.priceUnit ?? "request",
    currency: "USD",
    baseCredits: Math.ceil(input.providerCostMicrousd / 1000),
    pricingSource: input.pricingSource ?? "manual_initial_estimate",
    pricingConfidence: input.pricingConfidence ?? "medium",
    effectiveFrom: "2026-01-01",
    fetchedAt: "2026-01-01",
    staleAfter: undefined
  };
}

function seededFallbackPrice(input: Omit<Parameters<typeof seededPrice>[0], "pricingSource" | "pricingConfidence">): ProviderModelPricingV1 {
  return seededPrice({
    ...input,
    pricingSource: "fallback_estimate",
    pricingConfidence: "low"
  });
}

function cloneRecord<T extends Record<string, unknown> | undefined>(value: T): T {
  return value ? { ...value } as T : value;
}
