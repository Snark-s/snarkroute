import {
  listCuratedModelMetadataV1,
  groupCanonicalModelOptionsV1,
  mergeProviderModelsWithCuratedMetadata,
  normalizeProviderModelToV1Input,
  modelInputSlotsV1,
  modelRunnableWithSuppliedInputsV1,
  providerParameterDefinitionsV1,
  providerParameterIOContractV1,
  withDefaultModelInputLimitsV1
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
  ModelParameterDefinitionV1,
  ModelAvailabilityV1
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
  supported_frame_images?: unknown;
  supported_frame_image_modes?: unknown;
  generate_audio?: unknown;
  seed?: unknown;
  allowed_passthrough_parameters?: unknown;
  availability?: ModelAvailabilityV1;
  canonicalModelId?: string;
  providerConstraints?: Record<string, unknown>;
};

export type AssembleModelCatalogV1Input = {
  rutronixModels?: RawProviderModelV1[];
  polzaModels?: RawProviderModelV1[];
  openRouterModels?: RawProviderModelV1[];
  kieModels?: RawProviderModelV1[];
  localUpscaleModels?: RawProviderModelV1[];
  localVideoUpscaleModels?: RawProviderModelV1[];
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
  return assembleProviderModelsV1(dedupeProviderModelsV1([
    ...normalizeRuTronixModelsForCatalogV1(input.rutronixModels ?? []),
    ...normalizePolzaModelsForCatalogV1(input.polzaModels ?? []),
    ...normalizeOpenRouterModelsForCatalogV1(input.openRouterModels ?? []),
    ...normalizeKieModelsForCatalogV1(input.kieModels ?? []),
    ...normalizeLocalUpscaleModelsForCatalogV1(input.localUpscaleModels ?? []),
    ...normalizeLocalVideoUpscaleModelsForCatalogV1(input.localVideoUpscaleModels ?? []),
    ...(input.fallbackModels ?? [])
  ]), input.curatedMetadata ?? listCuratedModelMetadataV1());
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

export function normalizeRuTronixModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("rutronix", { ...model, type: model.type ?? "chat", inputTypes: model.inputTypes ?? ["text"], outputTypes: model.outputTypes ?? ["text"], capabilities: model.capabilities ?? ["text.generate"] }));
}

export function normalizeOpenRouterModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("openrouter", model));
}

export function normalizeKieModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("kie", model));
}

export function normalizeLocalUpscaleModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("local_upscale", model));
}

export function normalizeLocalVideoUpscaleModelsForCatalogV1(models: RawProviderModelV1[]): ProviderModelInfoV1[] {
  return models.flatMap((model) => normalizeRawProviderModel("local_video_upscale", model));
}

function dedupeProviderModelsV1(providerModels: ProviderModelInfoV1[]): ProviderModelInfoV1[] {
  const seen = new Set<string>();
  return providerModels.filter((model) => {
    const key = `${model.provider}:${model.providerModelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fallbackProviderModelsForCatalogV1(): ProviderModelInfoV1[] {
  return [
    normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "openai/gpt-5.1",
      displayName: "OpenAI: GPT-5.1",
      inputTypes: ["text", "image"],
      outputTypes: ["text"],
      capabilities: ["text.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "openrouter-text-catalog", providerEndpoint: "chat.completions" }
    }),
    normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "openai/gpt-image-1",
      displayName: "OpenAI: GPT Image 1",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate", "image.edit", "image.reference"],
      roles: ["generator", "editor"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "openrouter-image-generation-catalog", providerEndpoint: "chat.completions" }
    }),
    normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "google/gemini-3-pro-image-preview",
      displayName: "Google: Gemini 3 Pro Image Preview",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate", "image.reference"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "openrouter-image-generation-catalog", providerEndpoint: "chat.completions" }
    }),
    normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "bytedance/seedream-5-lite",
      displayName: "ByteDance: Seedream 5 Lite",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate", "image.reference"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "openrouter-image-generation-catalog", providerEndpoint: "chat.completions" }
    }),
    normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "black-forest-labs/flux-kontext-pro",
      displayName: "Black Forest Labs: FLUX Kontext Pro",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate", "image.edit", "image.reference"],
      roles: ["generator", "editor"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "openrouter-image-generation-catalog", providerEndpoint: "chat.completions" }
    }),
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
      providerModelId: "openai/gpt-4o",
      displayName: "OpenAI GPT-4o",
      inputTypes: ["text", "image"],
      outputTypes: ["text"],
      capabilities: ["text.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "polza-default-text-model", providerEndpoint: "chat" }
    }),
    normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "openai/gpt-5.4-image-2",
      displayName: "OpenAI GPT-5.4 Image 2",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate", "image.edit", "image.reference"],
      roles: ["generator", "editor"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "polza-default-image-model", providerEndpoint: "media" }
    }),
    normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "wan/2.6",
      displayName: "WAN 2.6",
      inputTypes: ["text", "image", "video"],
      outputTypes: ["video"],
      capabilities: ["video.generate"],
      roles: ["generator"],
      availability: { status: "available", source: "fallback" },
      metadata: { fallback: "polza-default-video-model", providerEndpoint: "media" }
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
  const options = catalog
    .filter((entry) => isModelCompatibleWithNodeV1(nodeType, entry))
    .map((entry) => toModelOptionForNodeV1(nodeType, entry))
    .sort((left, right) =>
      providerSortOrder(left.provider) - providerSortOrder(right.provider)
      || left.displayName.localeCompare(right.displayName)
      || left.providerModelId.localeCompare(right.providerModelId)
    );
  return nodeType.startsWith("ai.") ? groupCanonicalModelOptionsV1(options) : options;
}

export function isModelCompatibleWithNodeV1(nodeType: string, entry: ModelCatalogEntryV1): boolean {
  if (entry.availability.status !== "available") return false;
  if (nodeType === "polza.image.generate") {
    return entry.provider === "polza"
      && hasOutputType(entry, "image")
      && !entry.roles.includes("upscaler");
  }
  if (nodeType === "polza.text") {
    return entry.provider === "polza" && hasOutputType(entry, "text");
  }
  if (nodeType === "polza.video.generate") {
    return entry.provider === "polza" && hasOutputType(entry, "video") && !isUpscaleOnlyModel(entry, "video");
  }
  if (nodeType === "ai.image.generate") {
    return (entry.provider === "openrouter" || entry.provider === "gemini" || entry.provider === "polza" || entry.provider === "kie")
      && entry.providerModelId !== "openrouter/auto"
      && hasOutputType(entry, "image")
      && !isUpscaleOnlyModel(entry, "image");
  }
  if (nodeType === "ai.video.generate") {
    return (entry.provider === "openrouter" || entry.provider === "polza" || entry.provider === "kie")
      && hasOutputType(entry, "video")
      && !isUpscaleOnlyModel(entry, "video");
  }
  if (nodeType === "ai.text") {
    return (entry.provider === "openrouter" || entry.provider === "rutronix" || entry.provider === "kie") && hasOutputType(entry, "text") && hasOnlyOutputTypes(entry, ["text", "json"]);
  }
  if (nodeType === "ai.audio.generate") {
    return hasOutputType(entry, "audio") && !entry.roles.includes("upscaler");
  }
  if (nodeType === "local_upscale") {
    return entry.provider === "local_upscale"
      && entry.capabilities.includes("image.upscale")
      && hasOutputType(entry, "image");
  }
  if (nodeType === "local_video_upscale") {
    return entry.provider === "local_video_upscale"
      && entry.capabilities.includes("video.upscale")
      && hasOutputType(entry, "video");
  }
  return false;
}

export function toModelOptionForNodeV1(nodeType: string, entry: ModelCatalogEntryV1): ModelOptionForNodeV1 {
  const image = entry.ioContract?.inputs?.find((item) => item.kind === "image");
  return {
    ...entry,
    nodeType,
    storedModelId: entry.provider === "rutronix" ? `rutronix:${entry.providerModelId}` : entry.providerModelId,
    executionProvider: entry.provider,
    compatibilityReason: compatibilityReasonForNode(nodeType),
    inputContract: entry.ioContract,
    requiredImageInputs: image?.minItems ?? (image?.required ? 1 : 0),
    maximumImageInputs: image?.maxItems,
    optionalImageInputs: image ? Math.max(0, (image.maxItems ?? 1) - (image.minItems ?? (image.required ? 1 : 0))) : 0,
    inputRoles: modelInputSlotsV1(entry).filter((slot) => slot.kind === "image").map((slot) => slot.role),
    runnableWithSuppliedInputs: modelRunnableWithSuppliedInputsV1(entry, {})
  };
}

/** Provider-neutral catalog projection. The original provider rows remain available
 * for legacy consumers; every canonical row carries its executable providerRoutes. */
export function canonicalModelCatalogV1(catalog: ModelCatalogEntryV1[]): ModelOptionForNodeV1[] {
  return groupCanonicalModelOptionsV1(catalog.map((entry) => ({
    ...entry,
    nodeType: "catalog",
    storedModelId: entry.providerModelId,
    executionProvider: entry.provider
  })));
}

function normalizeRawProviderModel(provider: ModelProviderIdV1, model: RawProviderModelV1): ProviderModelInfoV1[] {
  const providerModelId = stringValue(model.id);
  if (!providerModelId) return [];
  const outputTypes = outputTypesForModel(model);
  const capabilities = capabilitiesForModel(model, outputTypes);
  const providerParams = providerParameters(model);
  const providerParameterDefinitions = mergeParameterDefinitions(
    providerParameterDefinitionsV1(providerParams),
    provider === "openrouter" ? supportedGenerationParameterDefinitions(model) : []
  );
  const inputTypes = inputTypesForModel(model);
  const ioContract = providerVideoIOContractV1(provider, model, providerParameterIOContractV1(providerParams, inputTypes, outputTypes));
  const contractInputTypes = (ioContract.inputs ?? []).map((item) => item.kind) as ModelInputTypeV1[];
  return [normalizeProviderModelToV1Input({
    provider,
    providerModelId,
    canonicalModelId: stringValue(model.canonicalModelId),
    displayName: stringValue(model.title) ?? stringValue(model.name) ?? providerModelId,
    inputTypes: unique([...inputTypes, ...contractInputTypes]),
    outputTypes,
    capabilities,
    roles: rolesForCapabilities(capabilities),
    availability: model.availability ?? { status: "available", source: "live" },
    metadata: { providerRaw: model, providerParameterDefinitions, providerConstraints: model.providerConstraints },
    ioContract
  })];
}

function preserveLiveProviderIo(entry: ModelCatalogEntryV1, providerModel: ProviderModelInfoV1 | undefined): ModelCatalogEntryV1 {
  if (!providerModel) return entry;
  return {
    ...entry,
    inputTypes: providerModel.inputTypes.length ? providerModel.inputTypes : entry.inputTypes,
    outputTypes: providerModel.outputTypes.length ? providerModel.outputTypes : entry.outputTypes,
    ioContract: providerModel.ioContract ?? entry.ioContract
  };
}

function enrichUiCatalogMetadata(entry: ModelCatalogEntryV1): ModelCatalogEntryV1 {
  const defaults = defaultUiCatalogMetadata(entry);
  const providerMetadata = entry.metadata?.provider && typeof entry.metadata.provider === "object" ? entry.metadata.provider as Record<string, unknown> : undefined;
  const liveParameters = Array.isArray(providerMetadata?.providerParameterDefinitions) ? providerMetadata.providerParameterDefinitions as ModelParameterDefinitionV1[] : [];
  const baseParameters = entry.parameters.length ? entry.parameters : defaults?.parameters ?? [];
  const enriched = defaults || liveParameters.length ? {
    ...entry,
    parameters: mergeParameterDefinitions(baseParameters, liveParameters),
    metadata: {
      ...(entry.metadata ?? {}),
      ...(defaults?.metadata ?? {})
    }
  } : entry;
  const withPricing = entry.provider === "local_upscale" || entry.provider === "local_video_upscale" ? {
    ...enriched,
    pricing: { status: "fresh" as const, source: "manual" as const, currency: "USD", unit: "run", pricing: { providerCostMicrousd: 0, apiCost: 0 } }
  } : entry.provider === "kie" ? {
    ...enriched,
    pricing: entry.providerModelId === "nano-banana-pro"
      ? { status: "fresh" as const, source: "manual" as const, currency: "USD", unit: "image", pricing: { oneToTwoKMicrousd: 90_000, fourKMicrousd: 120_000 }, refreshedAt: "2026-08-21" }
      : { status: "unknown" as const, source: "unknown" as const, currency: "USD", unit: "provider-credit", pricing: {}, warning: "KIE reports provider credits after completion; stable USD pricing is not documented for this route." }
  } : enriched;
  return withDefaultModelInputLimitsV1({ ...withPricing, ioContract: completeIoContract(withPricing) });
}

function completeIoContract(entry: ModelCatalogEntryV1) {
  const fallback = providerParameterIOContractV1(undefined, entry.inputTypes, entry.outputTypes);
  if (!entry.ioContract) return fallback;
  const inputKinds = new Set((entry.ioContract.inputs ?? []).map((item) => item.kind));
  const outputKinds = new Set((entry.ioContract.outputs ?? []).map((item) => item.kind));
  return {
    inputs: [...(entry.ioContract.inputs ?? []), ...(fallback.inputs ?? []).filter((item) => !inputKinds.has(item.kind))],
    outputs: [...(entry.ioContract.outputs ?? []), ...(fallback.outputs ?? []).filter((item) => !outputKinds.has(item.kind))]
  };
}

function mergeParameterDefinitions(base: ModelParameterDefinitionV1[], preferred: ModelParameterDefinitionV1[]) {
  const byId = new Map(base.map((field) => [canonicalParameterId(field.id), field]));
  for (const field of preferred) {
    const key = canonicalParameterId(field.id);
    byId.set(key, { ...(byId.get(key) ?? {}), ...field });
  }
  return [...byId.values()];
}

function canonicalParameterId(id: string): string {
  return id.replace(/[_-]/g, "").toLowerCase();
}

function defaultUiCatalogMetadata(entry: ModelCatalogEntryV1): { parameters: ModelParameterDefinitionV1[]; metadata?: Record<string, unknown> } | undefined {
  if (entry.provider === "polza" && entry.providerModelId === "kling/v3-motion-control") {
    return undefined;
  }
  if (entry.provider === "polza" && hasOutputType(entry, "video") && !entry.roles.includes("upscaler")) {
    return {
      parameters: [videoResolutions, videoDurations, videoMultiShots]
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
  const inputTypes = normalizeInputTypes([
    ...stringArray(model.inputTypes),
    ...stringArray(model.architecture?.input_modalities)
  ]);
  return frameImageModes(model).length && !inputTypes.includes("image") ? [...inputTypes, "image"] : inputTypes;
}

function providerVideoIOContractV1(
  provider: ModelProviderIdV1,
  model: RawProviderModelV1,
  contract: ReturnType<typeof providerParameterIOContractV1>
) {
  const modes = provider === "openrouter" ? frameImageModes(model) : [];
  if (!modes.length) return contract;
  const slots = modes.map((mode) => ({
    id: mode,
    role: mode === "last_frame" ? "lastFrame" : "firstFrame",
    label: mode === "last_frame" ? "Last frame" : "First frame",
    minItems: 0,
    maxItems: 1,
    required: false,
    ordered: true
  }));
  const image = {
    kind: "image" as const,
    minItems: 0,
    maxItems: slots.length,
    required: false,
    roles: slots.map((slot) => slot.role),
    slots,
    ordered: true
  };
  return {
    ...contract,
    inputs: [image, ...(contract.inputs ?? []).filter((item) => item.kind !== "image")]
  };
}

function frameImageModes(model: RawProviderModelV1): string[] {
  return unique([
    ...stringArray(model.supported_frame_images),
    ...stringArray(model.supported_frame_image_modes)
  ]).filter((mode) => mode === "first_frame" || mode === "last_frame");
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
  if (nodeType === "local_upscale") return "available through the configured local upscale worker";
  if (nodeType === "local_video_upscale") return "available through the configured local video upscale worker";
  if (nodeType.startsWith("polza.")) return "available through Polza with provider-native model id";
  if (nodeType.startsWith("ai.")) return "available through the selected provider with provider-native model id";
  return "available through provider catalog";
}

function providerSortOrder(provider: ModelProviderIdV1): number {
  if (provider === "polza") return 0;
  if (provider === "rutronix") return 1;
  if (provider === "openrouter") return 2;
  return 3;
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

function providerParameters(model: RawProviderModelV1): Record<string, unknown> | undefined {
  const topProvider = model.top_provider && typeof model.top_provider === "object" && !Array.isArray(model.top_provider) ? model.top_provider as Record<string, unknown> : undefined;
  const parameters = topProvider?.parameters;
  return parameters && typeof parameters === "object" && !Array.isArray(parameters) ? parameters as Record<string, unknown> : undefined;
}

function supportedGenerationParameterDefinitions(model: RawProviderModelV1): ModelParameterDefinitionV1[] {
  const definitions: Array<ModelParameterDefinitionV1 | undefined> = [
    supportedSelectParameter("aspectRatio", "Aspect ratio", model.supported_aspect_ratios),
    supportedSelectParameter("duration", "Duration", model.supported_durations),
    supportedSelectParameter("resolution", "Resolution", model.supported_resolutions),
    model.generate_audio === true ? { id: "generate_audio", label: "Generate audio", type: "boolean", default: true } : undefined,
    model.seed === true ? { id: "seed", label: "Seed", type: "number", min: 0, max: 2147483647, step: 1, advanced: true } : undefined
  ];
  const passthrough = new Set(stringArray(model.allowed_passthrough_parameters));
  if (passthrough.has("negative_prompt")) definitions.push({ id: "negative_prompt", label: "Negative prompt", type: "text", default: "", advanced: true });
  if (passthrough.has("cfg_scale")) definitions.push({ id: "cfg_scale", label: "CFG scale", type: "number", min: 0, max: 20, step: 0.1, advanced: true });
  for (const [id, label, defaultValue] of [
    ["prompt_optimizer", "Prompt optimizer", true],
    ["fast_pretreatment", "Fast pretreatment", false],
    ["watermark", "Watermark", false],
    ["prompt_extend", "Prompt expansion", true],
    ["enable_prompt_expansion", "Prompt expansion", true]
  ] as const) {
    if (passthrough.has(id)) definitions.push({ id, label, type: "boolean", default: defaultValue, advanced: true });
  }
  return definitions.flatMap((definition) => definition ? [definition] : []);
}

function supportedSelectParameter(id: string, label: string, rawValues: unknown): ModelParameterDefinitionV1 | undefined {
  const values = unique(stringArray(rawValues));
  return values.length ? parameter(id, label, values, values[0]) : undefined;
}

function modalityOutputModalities(modality: string): string[] {
  if (!modality) return [];
  const outputSide = modality.includes("->") ? modality.split("->").pop() ?? "" : modality;
  return outputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
