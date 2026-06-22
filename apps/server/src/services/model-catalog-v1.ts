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
  ModelOptionForNodeV1,
  ModelParameterDefinitionV1
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
    enrichUiCatalogMetadata(preserveLiveProviderIo(entry, providerModels[index]))
  );
}

export function normalizePolzaModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("polza", model));
}

export function normalizeOpenRouterModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("openrouter", model));
}

export function fallbackProviderModelsForCatalogV1(): ProviderModelInfoV1[] {
  return [
    normalizeProviderModelToV1Input({
      provider: "gemini",
      providerModelId: "image.nano-banana",
      displayName: "Nano Banana",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "studio-direct-image-alias" }
    }),
    normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "suno/generate",
      displayName: "Suno Music Generate",
      inputTypes: ["text", "audio"],
      outputTypes: ["audio"],
      capabilities: ["audio.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "polza-docs-suno-music", audioFamily: "music", providerEndpoint: "media", priceRub: 15, tracksPerGeneration: 1 }
    }),
    normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "suno/sounds",
      displayName: "Suno Sounds",
      inputTypes: ["text", "audio"],
      outputTypes: ["audio"],
      capabilities: ["audio.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "polza-public-model-page", audioFamily: "sound-effects", providerEndpoint: "media", priceRub: 2, tracksPerGeneration: 2 }
    }),
    normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "elevenlabs/eleven-turbo-v2",
      displayName: "ElevenLabs: Eleven Turbo v2",
      inputTypes: ["text"],
      outputTypes: ["audio"],
      capabilities: ["audio.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "openrouter-speech-docs-example", audioFamily: "voice", providerEndpoint: "audio.speech" }
    }),
    normalizeProviderModelToV1Input({
      provider: "elevenlabs",
      providerModelId: "music_v2",
      displayName: "ElevenLabs: Music v2",
      inputTypes: ["text", "audio"],
      outputTypes: ["audio"],
      capabilities: ["audio.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "elevenlabs-model-docs", audioFamily: "music", providerEndpoint: "music" }
    }),
    normalizeProviderModelToV1Input({
      provider: "elevenlabs",
      providerModelId: "eleven_text_to_sound_v2",
      displayName: "ElevenLabs: Text to Sound v2",
      inputTypes: ["text"],
      outputTypes: ["audio"],
      capabilities: ["audio.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "elevenlabs-model-docs", audioFamily: "sound-effects", providerEndpoint: "sound-effects" }
    }),
    normalizeProviderModelToV1Input({
      provider: "elevenlabs",
      providerModelId: "eleven_v3",
      displayName: "ElevenLabs: Eleven v3",
      inputTypes: ["text"],
      outputTypes: ["audio"],
      capabilities: ["audio.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "elevenlabs-model-docs", audioFamily: "voice", providerEndpoint: "text-to-speech" }
    })
  ];
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
  if (nodeType === "ai.audio.generate") {
    return hasOutputType(entry, "audio") && !entry.roles.includes("upscaler");
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
    inputTypes: providerModel.inputTypes.length ? providerModel.inputTypes : entry.inputTypes,
    outputTypes: providerModel.outputTypes.length ? providerModel.outputTypes : entry.outputTypes
  };
}

function enrichUiCatalogMetadata(entry: ModelCatalogEntryV1): ModelCatalogEntryV1 {
  const defaults = defaultUiCatalogMetadata(entry);
  if (!defaults) return entry;
  return {
    ...entry,
    parameters: entry.parameters.length ? entry.parameters : defaults.parameters,
    metadata: {
      ...(entry.metadata ?? {}),
      ...defaults.metadata
    }
  };
}

function defaultUiCatalogMetadata(entry: ModelCatalogEntryV1): { parameters: ModelParameterDefinitionV1[]; metadata?: Record<string, unknown> } | undefined {
  if (entry.provider === "polza" && hasOutputType(entry, "video") && !entry.roles.includes("upscaler")) {
    return {
      parameters: [videoResolutions, videoDurations, videoMultiShots],
      metadata: { maxImageInputs: polzaVideoMaxImageInputs(entry.providerModelId) }
    };
  }
  if (entry.provider === "polza" && hasOutputType(entry, "image") && !entry.roles.includes("upscaler")) {
    return {
      parameters: [aspectRatios, imageResolutions, imageQualities, outputFormats, imageCount]
    };
  }
  if (entry.provider === "gemini" && hasOutputType(entry, "image")) {
    return {
      parameters: [aspectRatios, imageSizes]
    };
  }
  if (hasOutputType(entry, "audio") && !entry.roles.includes("upscaler")) {
    const providerMetadata = entry.metadata?.provider;
    const audioFamily = typeof entry.metadata?.audioFamily === "string"
      ? entry.metadata.audioFamily
      : providerMetadata && typeof providerMetadata === "object" && typeof (providerMetadata as Record<string, unknown>).audioFamily === "string"
        ? String((providerMetadata as Record<string, unknown>).audioFamily)
        : "";
    if (entry.providerModelId === "suno/generate" || entry.providerModelId === "suno/sounds") {
      return {
        parameters: sunoMusicParameters
      };
    }
    return {
      parameters: entry.provider === "openrouter" || audioFamily === "voice" ? [audioVoice, audioResponseFormat] : [audioDurationSeconds]
    };
  }
  return undefined;
}

function polzaVideoMaxImageInputs(modelId: string): number {
  if (modelId === "wan/2.6") return 1;
  return 14;
}

const aspectRatios = parameter("aspectRatio", "Aspect ratio", ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"], "1:1");
const imageResolutions = parameter("imageResolution", "Resolution", ["1K", "2K", "4K"], "2K");
const imageSizes = parameter("imageSize", "Resolution", ["1K", "2K", "4K"], "2K");
const imageQualities = parameter("quality", "Quality", ["draft", "standard", "high"], "high");
const outputFormats = parameter("outputFormat", "Format", ["png", "jpg", "webp"], "png");
const videoResolutions = parameter("resolution", "Resolution", ["720p", "1080p"], "720p");
const videoDurations = parameter("duration", "Duration", ["5", "10", "15"], "5");
const videoMultiShots = parameter("multi_shots", "Multi-shot", ["false", "true"], "false");
const audioDurationSeconds = parameter("duration", "Duration", ["30", "60", "120"], "30");
const audioVoice: ModelParameterDefinitionV1 = { id: "voice", label: "Voice", type: "text", default: "alloy" };
const audioResponseFormat = parameter("response_format", "Format", ["mp3", "wav", "pcm"], "mp3");
const sunoCustomMode = { parameterId: "mode", equals: ["custom"] };
const sunoSimpleMode = { parameterId: "mode", equals: ["simple"] };
const sunoMusicParameters: ModelParameterDefinitionV1[] = [
  { id: "mode", label: "Mode", type: "select", default: "custom", options: [{ value: "custom", label: "Custom" }, { value: "simple", label: "Simple" }] },
  { id: "instrumental", label: "Instrumental", type: "boolean", default: false, enabledWhen: sunoSimpleMode },
  { id: "style", label: "Style", type: "text", default: "", enabledWhen: sunoCustomMode },
  { id: "title", label: "Title", type: "text", default: "", advanced: true, enabledWhen: sunoCustomMode },
  { id: "version", label: "Version", type: "select", default: "V5", advanced: true, enabledWhen: sunoCustomMode, options: ["V5", "V4_5ALL", "V4_5PLUS", "V4_5", "V4", "V3_5"].map((value) => ({ value })) },
  { id: "negative_tags", label: "Avoid", type: "text", default: "", advanced: true, enabledWhen: sunoCustomMode },
  { id: "language", label: "Language", type: "text", default: "", advanced: true, enabledWhen: sunoCustomMode },
  { id: "tempo", label: "Tempo", type: "text", default: "", advanced: true, enabledWhen: sunoCustomMode },
  { id: "voice_style", label: "Vocal style", type: "text", default: "", advanced: true, enabledWhen: sunoCustomMode }
];
const imageCount: ModelParameterDefinitionV1 = { id: "n", label: "Images", type: "number", default: 1, min: 1, max: 4, step: 1 };

function parameter(id: string, label: string, options: string[], defaultValue: string): ModelParameterDefinitionV1 {
  return { id, label, type: "select", default: defaultValue, options: options.map((value) => ({ value })) };
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
  return unique(values.map((value) => value.toLowerCase() === "speech" ? "audio" : value.toLowerCase()).filter((value): value is ModelOutputTypeV1 => allowed.has(value as ModelOutputTypeV1)));
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
