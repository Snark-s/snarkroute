import {
  listCuratedModelMetadataV1,
  mergeProviderModelsWithCuratedMetadata,
  normalizeProviderModelToV1Input
} from "@snarkroute/model-catalog/dist/v1/index.js";

import type {
  CuratedModelMetadataV1,
  ModelCapabilityV1,
  ModelInputTypeV1,
  ModelOutputTypeV1,
  ModelProviderIdV1,
  ModelRoleV1,
  ProviderModelInfoV1,
  ModelCatalogEntryV1,
  ModelOptionForNodeV1
} from "@snarkroute/model-catalog/dist/v1/index.js";

export type RawProviderModelV1 = Record<string, unknown> & {
  id?: string;
  name?: string;
  title?: string;
  type?: string;
  kind?: string;
  capabilities?: unknown;
  inputTypes?: unknown;
  outputTypes?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
    modality?: unknown;
  };
};

export type AssembleModelCatalogV1Input = {
  polzaModels?: RawProviderModelV1[];
  openRouterModels?: RawProviderModelV1[];
  fallbackModels?: ProviderModelInfoV1[];
  curatedMetadata?: CuratedModelMetadataV1[];
};

const textOnlyProviderModelIds = new Set([
  "openai/gpt-5.1",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.2",
  "openai/gpt-5.2-chat"
]);

export function assembleModelCatalogV1(input: AssembleModelCatalogV1Input): ModelCatalogEntryV1[] {
  return assembleProviderModelsV1([
    ...normalizePolzaModelsForCatalogV1(input.polzaModels ?? []),
    ...normalizeOpenRouterModelsForCatalogV1(input.openRouterModels ?? []),
    ...(input.fallbackModels ?? [])
  ], input.curatedMetadata ?? listCuratedModelMetadataV1());
}

export function assembleProviderModelsV1(
  providerModels: ProviderModelInfoV1[],
  curatedMetadata: CuratedModelMetadataV1[] = listCuratedModelMetadataV1()
): ModelCatalogEntryV1[] {
  return mergeProviderModelsWithCuratedMetadata(providerModels, curatedMetadata).map((entry, index) =>
    preserveLiveProviderIo(entry, providerModels[index])
  );
}

export function normalizePolzaModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("polza", model));
}

export function normalizeOpenRouterModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("openrouter", model));
}

export function fallbackProviderModelsForCatalogV1(): ProviderModelInfoV1[] {
  return [normalizeProviderModelToV1Input({
    provider: "gemini",
    providerModelId: "image.nano-banana",
    displayName: "Nano Banana",
    inputTypes: ["text", "image"],
    outputTypes: ["image"],
    capabilities: ["image.generate"],
    roles: ["generator"],
    availability: { status: "available", source: "fallback" },
    metadata: { fallback: "studio-direct-image-alias" }
  })];
}

export function modelOptionsForNodeV1(nodeType: string, catalog: ModelCatalogEntryV1[]): ModelOptionForNodeV1[] {
  return catalog
    .filter((entry) => isModelCompatibleWithNodeV1(nodeType, entry))
    .map((entry) => toModelOptionForNodeV1(nodeType, entry))
    .sort((left, right) =>
      providerSortOrder(left.provider) - providerSortOrder(right.provider)
      || left.displayName.localeCompare(right.displayName)
      || left.providerModelId.localeCompare(right.providerModelId)
    );
}

export function isModelCompatibleWithNodeV1(nodeType: string, entry: ModelCatalogEntryV1): boolean {
  if (entry.availability.status !== "available") return false;
  if (nodeType === "polza.image.generate") {
    return entry.provider === "polza" && hasOutputType(entry, "image") && !entry.roles.includes("upscaler");
  }
  if (nodeType === "polza.text") {
    return entry.provider === "polza" && hasOutputType(entry, "text");
  }
  if (nodeType === "polza.video.generate") {
    return entry.provider === "polza" && hasOutputType(entry, "video") && !isUpscaleOnlyModel(entry, "video");
  }
  if (nodeType === "ai.image.generate") {
    return (entry.provider === "openrouter" || entry.provider === "gemini")
      && entry.providerModelId !== "openrouter/auto"
      && hasOutputType(entry, "image")
      && !isUpscaleOnlyModel(entry, "image");
  }
  if (nodeType === "ai.text") {
    return entry.provider === "openrouter" && hasOutputType(entry, "text") && hasOnlyOutputTypes(entry, ["text", "json"]);
  }
  return false;
}

export function toModelOptionForNodeV1(nodeType: string, entry: ModelCatalogEntryV1): ModelOptionForNodeV1 {
  return {
    ...entry,
    nodeType,
    storedModelId: entry.providerModelId,
    executionProvider: entry.provider,
    compatibilityReason: compatibilityReasonForNode(nodeType)
  };
}

function normalizeRawProviderModel(provider: ModelProviderIdV1, model: RawProviderModelV1): ProviderModelInfoV1[] {
  const providerModelId = stringValue(model.id);
  if (!providerModelId) return [];
  const outputTypes = outputTypesForModel(model);
  const capabilities = capabilitiesForModel(model, outputTypes);
  return [normalizeProviderModelToV1Input({
    provider,
    providerModelId,
    displayName: stringValue(model.title) ?? stringValue(model.name) ?? providerModelId,
    inputTypes: inputTypesForModel(model),
    outputTypes,
    capabilities,
    roles: rolesForCapabilities(capabilities),
    availability: { status: "available", source: "live" },
    metadata: { providerRaw: model }
  })];
}

function preserveLiveProviderIo(entry: ModelCatalogEntryV1, providerModel: ProviderModelInfoV1 | undefined): ModelCatalogEntryV1 {
  if (!providerModel) return entry;
  return {
    ...entry,
    inputTypes: providerModel.inputTypes,
    outputTypes: providerModel.outputTypes
  };
}

function inputTypesForModel(model: RawProviderModelV1): ModelInputTypeV1[] {
  return normalizeInputTypes([
    ...stringArray(model.inputTypes),
    ...stringArray(model.architecture?.input_modalities)
  ]);
}

function outputTypesForModel(model: RawProviderModelV1): ModelOutputTypeV1[] {
  const providerModelId = stringValue(model.id)?.toLowerCase();
  if (providerModelId && textOnlyProviderModelIds.has(providerModelId)) return ["text"];
  const explicit = normalizeOutputTypes([
    ...stringArray(model.outputTypes),
    ...stringArray(model.architecture?.output_modalities),
    ...modalityOutputModalities(stringValue(model.architecture?.modality) ?? "")
  ]);
  if (explicit.length > 0) return explicit;
  const kind = stringValue(model.kind) ?? stringValue(model.type);
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "embedding") return [kind];
  if (kind === "chat" || kind === "text") return ["text"];
  return ["unknown"];
}

function capabilitiesForModel(model: RawProviderModelV1, outputTypes: ModelOutputTypeV1[]): ModelCapabilityV1[] {
  const explicit = stringArray(model.capabilities).filter((capability): capability is ModelCapabilityV1 => Boolean(capability));
  if (explicit.length > 0) return unique(explicit);
  return unique(outputTypes.flatMap((outputType): ModelCapabilityV1[] => {
    if (outputType === "text") return ["text.generate"];
    if (outputType === "image") return ["image.generate"];
    if (outputType === "video") return ["video.generate"];
    if (outputType === "audio") return ["audio.generate"];
    if (outputType === "embedding") return ["embedding.create"];
    if (outputType === "json") return ["json.generate"];
    return [];
  }));
}

function rolesForCapabilities(capabilities: ModelCapabilityV1[]): ModelRoleV1[] {
  const roles: ModelRoleV1[] = [];
  if (capabilities.some((capability) => capability.endsWith(".generate"))) roles.push("generator");
  if (capabilities.includes("image.edit")) roles.push("editor");
  if (capabilities.includes("image.upscale") || capabilities.includes("video.upscale")) roles.push("upscaler");
  if (capabilities.includes("embedding.create")) roles.push("embedding");
  return unique(roles);
}

function hasOutputType(entry: ModelCatalogEntryV1, outputType: ModelOutputTypeV1): boolean {
  return entry.outputTypes.includes(outputType);
}

function hasOnlyOutputTypes(entry: ModelCatalogEntryV1, outputTypes: ModelOutputTypeV1[]): boolean {
  const allowed = new Set<ModelOutputTypeV1>(outputTypes);
  return entry.outputTypes.length > 0 && entry.outputTypes.every((outputType) => allowed.has(outputType));
}

function isUpscaleOnlyModel(entry: ModelCatalogEntryV1, mediaType: "image" | "video"): boolean {
  const upscaleCapability = `${mediaType}.upscale`;
  return entry.roles.includes("upscaler")
    && entry.capabilities.includes(upscaleCapability)
    && !entry.capabilities.some((capability) => capability.startsWith(`${mediaType}.`) && capability !== upscaleCapability);
}

function compatibilityReasonForNode(nodeType: string): string {
  if (nodeType.startsWith("polza.")) return "available through Polza with provider-native model id";
  if (nodeType.startsWith("ai.")) return "available through OpenRouter with provider-native model id";
  return "available through provider catalog";
}

function providerSortOrder(provider: ModelProviderIdV1): number {
  if (provider === "polza") return 0;
  if (provider === "openrouter") return 1;
  return 2;
}

function normalizeInputTypes(values: string[]): ModelInputTypeV1[] {
  const allowed = new Set<ModelInputTypeV1>(["text", "image", "video", "audio", "file", "json"]);
  return unique(values.map((value) => value.toLowerCase()).filter((value): value is ModelInputTypeV1 => allowed.has(value as ModelInputTypeV1)));
}

function normalizeOutputTypes(values: string[]): ModelOutputTypeV1[] {
  const allowed = new Set<ModelOutputTypeV1>(["text", "image", "video", "audio", "embedding", "json", "unknown"]);
  return unique(values.map((value) => value.toLowerCase()).filter((value): value is ModelOutputTypeV1 => allowed.has(value as ModelOutputTypeV1)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function modalityOutputModalities(modality: string): string[] {
  if (!modality) return [];
  const outputSide = modality.includes("->") ? modality.split("->").pop() ?? "" : modality;
  return outputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
