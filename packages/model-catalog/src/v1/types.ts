import type { ModelIOContract } from "@snarkroute/protocol";

export type ModelProviderIdV1 =
  | "anthropic"
  | "gemini"
  | "local"
  | "openai"
  | "openrouter"
  | "polza"
  | "replicate"
  | "rutronix"
  | "seedance"
  | "unknown"
  | (string & {});

export type ModelOriginVendorV1 =
  | "anthropic"
  | "black-forest-labs"
  | "bytedance"
  | "google"
  | "kling"
  | "local"
  | "meta"
  | "minimax"
  | "nano-banana"
  | "openai"
  | "qwen"
  | "replicate"
  | "seedance"
  | "stability"
  | "topaz"
  | "wan"
  | "x-ai"
  | "z-ai"
  | "unknown"
  | (string & {});

export type ModelInputTypeV1 = "text" | "image" | "video" | "audio" | "file" | "json";
export type ModelOutputTypeV1 = "text" | "image" | "video" | "audio" | "embedding" | "json" | "unknown";

export type ModelCapabilityV1 =
  | "text.generate"
  | "json.generate"
  | "image.generate"
  | "image.edit"
  | "image.reference"
  | "image.upscale"
  | "video.generate"
  | "video.upscale"
  | "audio.generate"
  | "embedding.create"
  | (string & {});

export type ModelRoleV1 = "generator" | "editor" | "upscaler" | "router" | "embedding";

export type ModelAvailabilityV1 = {
  status: "available" | "unavailable" | "unknown";
  source: "live" | "cache" | "curated" | "fallback";
  configured?: boolean;
  refreshedAt?: string;
  reason?: string;
};

export type ModelPricingInfoV1 = {
  status: "fresh" | "stale" | "missing" | "unknown";
  source: "provider-live" | "provider-cache" | "manual" | "catalog-estimate" | "unknown";
  currency?: string;
  unit?: string;
  pricing?: Record<string, unknown>;
  refreshedAt?: string;
  expiresAt?: string;
  warning?: string;
};

export type ModelParameterValueV1 = string | number | boolean;

export type ModelParameterOptionV1 = {
  value: string;
  label?: string;
};

export type ModelParameterDefinitionV1 = {
  id: string;
  label?: string;
  type: "select" | "number" | "text" | "boolean";
  default?: ModelParameterValueV1;
  options?: ModelParameterOptionV1[];
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  advanced?: boolean;
  enabledWhen?: {
    parameterId: string;
    equals: ModelParameterValueV1[];
  };
};

export type ModelCatalogEntryV1 = {
  id: string;
  canonicalModelId?: string;
  provider: ModelProviderIdV1;
  providerModelId: string;
  originVendor: ModelOriginVendorV1;
  originModelId?: string;
  displayName: string;
  description?: string;
  iconKey: string;
  iconPath: string;
  inputTypes: ModelInputTypeV1[];
  outputTypes: ModelOutputTypeV1[];
  capabilities: ModelCapabilityV1[];
  roles: ModelRoleV1[];
  availability: ModelAvailabilityV1;
  parameters: ModelParameterDefinitionV1[];
  pricing?: ModelPricingInfoV1;
  catalogStatus: "known" | "unknown";
  aliases?: string[];
  metadata?: Record<string, unknown>;
  ioContract?: ModelIOContract;
};

export type ProviderModelInfoV1 = {
  provider: ModelProviderIdV1;
  providerModelId: string;
  canonicalModelId?: string;
  id: string;
  originVendor: ModelOriginVendorV1;
  displayName: string;
  inputTypes: ModelInputTypeV1[];
  outputTypes: ModelOutputTypeV1[];
  capabilities: ModelCapabilityV1[];
  roles: ModelRoleV1[];
  availability: ModelAvailabilityV1;
  metadata?: Record<string, unknown>;
  ioContract?: ModelIOContract;
};

export type CuratedModelMetadataV1 = {
  provider: ModelProviderIdV1;
  providerModelId: string;
  canonicalModelId?: string;
  aliases?: string[];
  originVendor?: ModelOriginVendorV1;
  originModelId?: string;
  displayName?: string;
  description?: string;
  iconKey?: string;
  iconPath?: string;
  inputTypes?: ModelInputTypeV1[];
  outputTypes?: ModelOutputTypeV1[];
  capabilities?: ModelCapabilityV1[];
  roles?: ModelRoleV1[];
  parameters?: ModelParameterDefinitionV1[];
  pricing?: ModelPricingInfoV1;
  metadata?: Record<string, unknown>;
  ioContract?: ModelIOContract;
};

export type ModelOptionForNodeV1 = ModelCatalogEntryV1 & {
  nodeType: string;
  storedModelId: string;
  executionProvider: ModelProviderIdV1;
  providerRoutes?: ModelProviderRouteV1[];
  compatibilityReason?: string;
  inputContract?: ModelIOContract;
  requiredImageInputs?: number;
  maximumImageInputs?: number;
  optionalImageInputs?: number;
  inputRoles?: string[];
  runnableWithSuppliedInputs?: boolean;
};

export type ModelProviderRouteV1 = {
  provider: ModelProviderIdV1;
  providerModelId: string;
  storedModelId: string;
  availability: ModelAvailabilityV1;
  inputTypes: ModelInputTypeV1[];
  outputTypes: ModelOutputTypeV1[];
  capabilities: ModelCapabilityV1[];
  parameters: ModelParameterDefinitionV1[];
  pricing?: ModelPricingInfoV1;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ioContract?: ModelIOContract;
};
