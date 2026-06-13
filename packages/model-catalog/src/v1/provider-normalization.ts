import type {
  ModelAvailabilityV1,
  ModelCapabilityV1,
  ModelInputTypeV1,
  ModelOriginVendorV1,
  ModelOutputTypeV1,
  ModelProviderIdV1,
  ModelRoleV1,
  ProviderModelInfoV1
} from "./types.js";

export type ProviderModelToV1Input = {
  provider: ModelProviderIdV1;
  providerModelId: string;
  displayName?: string;
  inputTypes?: ModelInputTypeV1[];
  outputTypes?: ModelOutputTypeV1[];
  capabilities?: ModelCapabilityV1[];
  roles?: ModelRoleV1[];
  availability?: Partial<ModelAvailabilityV1>;
  metadata?: Record<string, unknown>;
};

export function normalizeProviderModelToV1Input(input: ProviderModelToV1Input): ProviderModelInfoV1 {
  const providerModelId = input.providerModelId.trim();
  if (!providerModelId) throw new Error("providerModelId is required.");
  return {
    provider: input.provider,
    providerModelId,
    id: createUnifiedModelId(input.provider, providerModelId),
    originVendor: inferOriginVendorFromProviderModelId(providerModelId),
    displayName: input.displayName?.trim() || providerModelId,
    inputTypes: input.inputTypes ?? [],
    outputTypes: input.outputTypes ?? ["unknown"],
    capabilities: input.capabilities ?? [],
    roles: input.roles ?? [],
    availability: normalizeProviderAvailability(input.availability),
    metadata: input.metadata
  };
}

export function inferOriginVendorFromProviderModelId(providerModelId: string): ModelOriginVendorV1 {
  const normalized = providerModelId.trim().toLowerCase();
  if (normalized === "image.nano-banana" || normalized.includes("nano-banana")) return "nano-banana";
  const prefix = normalized.split("/")[0];
  if (prefix === "kwaivgi" || prefix === "kuaishou") return "kling";
  if (prefix === "tongyi-mai" || prefix === "zai" || prefix === "z-ai") return "z-ai";
  if (prefix === "x-ai" || prefix === "xai") return "x-ai";
  if (prefix === "minimax") return "minimax";
  return prefix || "unknown";
}

export function createUnifiedModelId(provider: ModelProviderIdV1, providerModelId: string): string {
  const normalizedProvider = String(provider).trim();
  const normalizedModelId = providerModelId.trim();
  if (!normalizedProvider) throw new Error("provider is required.");
  if (!normalizedModelId) throw new Error("providerModelId is required.");
  return `${normalizedProvider}:${normalizedModelId}`;
}

export function createProviderNativeStoredModelId(providerModelId: string): string {
  const normalizedModelId = providerModelId.trim();
  if (!normalizedModelId) throw new Error("providerModelId is required.");
  return normalizedModelId;
}

export function normalizeProviderAvailability(availability: Partial<ModelAvailabilityV1> = {}): ModelAvailabilityV1 {
  return {
    status: availability.status ?? "available",
    source: availability.source ?? "live",
    configured: availability.configured,
    refreshedAt: availability.refreshedAt,
    reason: availability.reason
  };
}
