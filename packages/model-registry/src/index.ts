export type ProviderMode = "auto" | "openrouter" | "direct" | "local";
export type SupportStatus = "supported" | "unsupported" | "unknown";

export type ResolvedModelProvider =
  | ResolvedModelBase & { provider: "openrouter"; model: string }
  | ResolvedModelBase & { provider: "direct"; model: string; directProvider: string }
  | ResolvedModelBase & { provider: "local"; model: string };

export interface ResolvedModelBase {
  reason: string;
  warnings: string[];
  selectedModelId: string;
  selectedModelLabel: string;
  selectedConnectionRoute: ProviderMode;
  resolvedProvider: string;
  resolvedRoute: "openrouter" | "direct" | "local";
  supportsImageGeneration: SupportStatus;
  localMappingRequired: boolean;
  mappingKeyUsed?: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface ModelMapping {
  id: string;
  task: string;
  defaultProvider?: string;
  openrouterModel?: string | null;
  directProvider?: string | null;
  directModel?: string | null;
  status?: "supported" | "partial" | "unsupported" | "unknown";
  notes?: string;
  label?: string;
  provider?: string;
  capabilities?: string[];
  supportsImageGeneration?: SupportStatus | boolean;
  routeSupport?: {
    openrouter?: SupportStatus;
    direct?: SupportStatus;
  };
}

export type ModelResolver = (input: { task: string; modelId?: string; providerMode?: ProviderMode }) => ResolvedModelProvider;

export function createModelResolver(mappings: ModelMapping[]): ModelResolver {
  return ({ task, modelId, providerMode = "auto" }) => resolveModelProvider({ task, modelId, providerMode, mappings });
}

export function resolveModelProvider({
  task,
  modelId,
  providerMode = "auto",
  mappings
}: {
  task: string;
  modelId?: string;
  providerMode?: ProviderMode;
  mappings: ModelMapping[];
}): ResolvedModelProvider {
  const mapping = mappings.find((entry) => entry.id === modelId || (!modelId || modelId === "auto" ? entry.task === task && entry.id.endsWith(".default") : false));
  const warnings = mapping?.notes ? [mapping.notes] : [];
  const selectedModelId = modelId || mapping?.id || `${task}.default`;
  const selectedModelLabel = mapping?.label || selectedModelId;
  const supportsImageGeneration = imageSupportFor(task, mapping, selectedModelId);
  const mappedOpenRouterSupport = routeSupport(mapping, "openrouter");
  const mappedDirectSupport = routeSupport(mapping, "direct");
  const hasOpenRouterSlug = Boolean(mapping?.openrouterModel || selectedModelId.includes("/"));
  const openrouterModel = mapping?.openrouterModel || (selectedModelId.includes("/") ? selectedModelId : undefined);
  const base = {
    warnings,
    selectedModelId,
    selectedModelLabel,
    selectedConnectionRoute: providerMode,
    supportsImageGeneration,
    fallbackUsed: false
  };
  if (task === "image" && supportsImageGeneration === "unsupported") throw new Error("This model is not available for image generation.");
  if (providerMode === "local") {
    if (mapping?.directProvider === "local" && mapping.directModel) return { ...base, provider: "local", resolvedProvider: "local", resolvedRoute: "local", model: mapping.directModel, reason: "Local model selected.", localMappingRequired: true, mappingKeyUsed: mapping.id };
    throw new Error("Local provider is not available.");
  }
  if (providerMode === "openrouter") {
    if (openrouterModel) {
      return { ...base, provider: "openrouter", resolvedProvider: "OpenRouter", resolvedRoute: "openrouter", model: openrouterModel, reason: "OpenRouter selected explicitly.", localMappingRequired: Boolean(mapping?.openrouterModel), mappingKeyUsed: mapping?.id };
    }
    throw new Error(mapping ? "This model is listed in the UI but has no executable image route." : "This model is not available for image generation.");
  }
  if (providerMode === "direct") {
    if (mapping?.directProvider && mapping.directModel) return { ...base, provider: "direct", resolvedProvider: mapping.directProvider, resolvedRoute: "direct", directProvider: mapping.directProvider, model: mapping.directModel, reason: "Direct API selected explicitly.", localMappingRequired: true, mappingKeyUsed: mapping.id };
    throw new Error(`Direct API route requires a provider mapping for ${selectedModelId}, but none was found.`);
  }
  if (openrouterModel && (mappedOpenRouterSupport === "supported" || (mapping?.status === "partial" && task !== "image"))) {
    return {
      ...base,
      provider: "openrouter",
      resolvedProvider: "OpenRouter",
      resolvedRoute: "openrouter",
      model: openrouterModel,
      reason: mapping?.status === "partial" ? "OpenRouter mapping is partial." : "OpenRouter mapping is supported.",
      warnings: mapping?.status === "partial" ? [...warnings, "This model mapping is partial. Check output format before production use."] : warnings,
      localMappingRequired: Boolean(mapping?.openrouterModel),
      mappingKeyUsed: mapping?.id
    };
  }
  if (mapping?.directProvider && mapping.directModel && mappedDirectSupport === "supported") {
    return { ...base, provider: "direct", resolvedProvider: mapping.directProvider, resolvedRoute: "direct", directProvider: mapping.directProvider, model: mapping.directModel, reason: "Direct API mapping is supported.", localMappingRequired: true, mappingKeyUsed: mapping.id };
  }
  if (task === "image" && (!mapping || hasOpenRouterSlug || supportsImageGeneration === "unknown")) {
    throw new Error("Auto route cannot resolve this model because image support is unknown. Choose OpenRouter or Direct API explicitly.");
  }
  throw new Error(mapping ? "This model is listed in the UI but has no executable image route." : "This model is not available for image generation.");
}

export function resolutionMetadata(resolution: ResolvedModelProvider, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selectedModelLabel: resolution.selectedModelLabel,
    selectedModelId: resolution.selectedModelId,
    selectedConnectionRoute: resolution.selectedConnectionRoute,
    resolvedProvider: resolution.resolvedProvider,
    resolvedRoute: resolution.resolvedRoute,
    supportsImageGeneration: resolution.supportsImageGeneration,
    localMappingRequired: resolution.localMappingRequired,
    mappingKeyUsed: resolution.mappingKeyUsed ?? null,
    fallbackUsed: resolution.fallbackUsed,
    fallbackReason: resolution.fallbackReason ?? null,
    requestProvider: resolution.provider,
    requestModelSlug: resolution.model,
    ...extra
  };
}

function imageSupportFor(task: string, mapping: ModelMapping | undefined, modelId: string): SupportStatus {
  if (task !== "image") return "unknown";
  if (typeof mapping?.supportsImageGeneration === "boolean") return mapping.supportsImageGeneration ? "supported" : "unsupported";
  if (mapping?.supportsImageGeneration) return mapping.supportsImageGeneration;
  if (mapping?.task === "image") return "supported";
  return modelId.includes("/") ? "unknown" : "unsupported";
}

function routeSupport(mapping: ModelMapping | undefined, route: "openrouter" | "direct"): SupportStatus {
  const explicit = mapping?.routeSupport?.[route];
  if (explicit) return explicit;
  if (route === "openrouter") {
    if (mapping?.openrouterModel && (mapping.status === "supported" || mapping.status === "partial")) return "supported";
    if (mapping?.openrouterModel === null || mapping?.status === "unsupported") return "unsupported";
  }
  if (route === "direct") {
    if (mapping?.directProvider && mapping.directModel) return "supported";
    if (mapping?.directProvider === null || mapping?.status === "unsupported") return "unsupported";
  }
  return "unknown";
}
