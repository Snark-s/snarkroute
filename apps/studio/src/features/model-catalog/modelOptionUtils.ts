import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_LLM_MODEL_OPTIONS,
  OPENAI_IMAGE_ASPECT_RATIOS,
  OPENAI_IMAGE_QUALITIES,
  apiBase
} from "../../studioConfig";
import { modelLogoFor, type ModelLogo } from "../../modelLogos";
import type {
  ImageModelOption,
  ModelOptionForNodeV1,
  OpenRouterModel,
  PolzaModel,
  UnifiedModelInfo,
  VideoModelOption
} from "../../studioTypes";
export function geminiLlmPricingLabel(modelValue: string): string {
  const model = GEMINI_LLM_MODEL_OPTIONS.find((entry) => entry.value === modelValue) ?? GEMINI_LLM_MODEL_OPTIONS[0];
  return `Paid tier: input $${model.inputUsdPerMillionTokens.toFixed(2)} / output $${model.outputUsdPerMillionTokens.toFixed(2)} per 1M tokens.`;
}

export function modelSupportsText(model: OpenRouterModel): boolean {
  if (model.capabilities?.includes("text.generate")) return true;
  if (model.kind === "video" || model.kind === "image") return false;
  const output = model.architecture?.output_modalities ?? model.outputTypes ?? [];
  const modality = model.architecture?.modality ?? "";
  return output.length === 0 || output.includes("text") || modality.includes("text");
}

export function modelSupportsImage(model: OpenRouterModel): boolean {
  if (isOpenRouterRoutingAlias(model.id)) return false;
  if (model.capabilities?.includes("image.generate")) return true;
  if (model.kind === "video") return false;
  const output = model.architecture?.output_modalities ?? model.outputTypes ?? [];
  const modality = model.architecture?.modality ?? "";
  return output.includes("image") || modalityOutputModalities(modality).includes("image");
}

export function modelSupportsVideo(model: OpenRouterModel): boolean {
  if (isOpenRouterRoutingAlias(model.id)) return false;
  if (model.capabilities?.includes("video.generate")) return true;
  const output = model.architecture?.output_modalities ?? model.outputTypes ?? [];
  const modality = model.architecture?.modality ?? "";
  return model.kind === "video" || output.includes("video") || modalityOutputModalities(modality).includes("video");
}

export function openRouterModelSupportsVisionInput(model: OpenRouterModel): boolean {
  if (isOpenRouterRoutingAlias(model.id)) return false;
  const input = model.architecture?.input_modalities ?? model.inputTypes ?? [];
  const modality = model.architecture?.modality ?? "";
  return input.includes("image") || modalityInputModalities(modality).includes("image");
}

export function polzaVideoSupportsAudio(model: PolzaModel | undefined): boolean {
  if (!model) return false;
  const parameterIds = new Set((model.generationParameters ?? []).map((parameter) => String(parameter.id ?? "").toLowerCase()));
  if (parameterIds.has("generate_audio") || parameterIds.has("audio") || parameterIds.has("sound")) return true;
  const supported = new Set((model.supported_parameters ?? []).map((parameter) => parameter.toLowerCase()));
  if (supported.has("generate_audio") || supported.has("audio") || supported.has("sound")) return true;
  const outputModalities = [
    ...(model.architecture?.output_modalities ?? []),
    ...(model.outputTypes ?? []),
    ...modalityOutputModalities(model.architecture?.modality ?? "")
  ].map((entry) => entry.toLowerCase());
  if (outputModalities.includes("audio")) return true;
  const searchable = `${model.id} ${model.name ?? ""} ${model.short_description ?? ""}`.toLowerCase();
  return /(^|[\/\s_-])veo-?3/.test(searchable) || /\baudio\b|\bsound\b/.test(searchable);
}

export function polzaModelSupportsVisionInput(model: PolzaModel): boolean {
  const input = model.architecture?.input_modalities ?? model.inputTypes ?? [];
  const modality = model.architecture?.modality ?? "";
  if (input.includes("image") || modalityInputModalities(modality).includes("image")) return true;
  return /(^|[/.-])(gpt-4o|gpt-4\.1|gemini|claude-3|pixtral|llava|vision)([/.-]|$)/i.test(model.id);
}

export function llmModelOptionLabel(label: string, id: string, supportsVision: boolean): string {
  const base = label === id ? id : `${label} (${id})`;
  return supportsVision ? `${base} - images` : base;
}

export function isOpenRouterRoutingAlias(modelId: string): boolean {
  return modelId === "openrouter/auto";
}

export function modalityInputModalities(modality: string): string[] {
  if (!modality) return [];
  const inputSide = modality.includes("->") ? modality.split("->")[0] ?? "" : modality;
  return inputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

export function modalityOutputModalities(modality: string): string[] {
  if (!modality) return [];
  const outputSide = modality.includes("->") ? modality.split("->").pop() ?? "" : modality;
  return outputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

export function videoModelOptionKey(model: Pick<VideoModelOption, "providerId" | "id">): string {
  return `${model.providerId}:${model.id}`;
}

export function polzaModelHint(model: PolzaModel | undefined, fallback: string): string {
  return model?.short_description || fallback;
}

export function videoModelHint(model: VideoModelOption | undefined, fallback: string): string {
  if (!model) return fallback;
  return model.short_description || `Video model via ${model.providerLabel}`;
}

export function imageGenerationModelOptions(openRouterModels: OpenRouterModel[], selectedModelId: string): ImageModelOption[] {
  const directOptions: ImageModelOption[] = [{
    id: "image.nano-banana",
    slug: "image.nano-banana",
    label: "Nano Banana",
    provider: "Gemini",
    executionProvider: "gemini",
    capabilities: ["image-generation"],
    aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
    imageSizes: GEMINI_IMAGE_SIZES,
    supportsImageGeneration: "supported",
    routeSupport: { openrouter: "unsupported", direct: "supported" }
  }];
  const openRouterImageOptions = openRouterModels
    .filter((entry) => modelSupportsImage(entry))
    .map((entry): ImageModelOption => ({
      id: entry.id,
      slug: entry.id,
      label: entry.name ?? entry.id,
      provider: providerFromSlug(entry.id),
      executionProvider: "openrouter",
      capabilities: ["image-generation"],
      aspectRatios: imageAspectRatiosForSlug(entry.id),
      imageSizes: imageSizesForSlug(entry.id),
      supportsImageGeneration: "supported",
      routeSupport: { openrouter: "supported", direct: "unknown" },
      pricing: entry.pricing
    }));
  const options = [...directOptions, ...openRouterImageOptions];
  if (selectedModelId && !options.some((entry) => entry.id === selectedModelId)) {
    const selectedCatalogModel = openRouterModels.find((entry) => entry.id === selectedModelId);
    options.push({
      id: selectedModelId,
      slug: selectedModelId,
      label: selectedCatalogModel?.name ?? selectedModelId,
      provider: selectedModelId.includes("/") ? providerFromSlug(selectedModelId) : "unknown",
      executionProvider: selectedModelId.includes("/") ? "openrouter" : undefined,
      capabilities: [],
      aspectRatios: imageAspectRatiosForSlug(selectedModelId),
      imageSizes: imageSizesForSlug(selectedModelId),
      supportsImageGeneration: selectedCatalogModel ? "unsupported" : "unknown",
      routeSupport: { openrouter: selectedModelId.includes("/") ? "unknown" : "unsupported", direct: "unknown" },
      disabled: true,
      note: selectedCatalogModel ? "not available for image generation" : "image support unknown",
      pricing: selectedCatalogModel?.pricing
    });
  }
  return options;
}

export function enrichImageGenerationModelOptions(options: ImageModelOption[], catalogModels: UnifiedModelInfo[]): ImageModelOption[] {
  if (catalogModels.length === 0) return options;
  return options.map((option) => {
    const catalogModel = catalogModels.find((entry) => catalogModelMatchesImageOption(entry, option));
    if (!catalogModel || !catalogModelSupportsImageGenerate(catalogModel)) return option;
    return {
      ...option,
      label: catalogModel.displayName || option.label,
      iconPath: catalogModel.iconPath,
      parameters: catalogModel.parameters,
      catalogModelId: catalogModel.id,
      catalogProviderModelId: catalogModel.providerModelId,
      aspectRatios: selectParameterValues(catalogModel.parameters, "aspectRatio") ?? option.aspectRatios,
      imageSizes: selectParameterValues(catalogModel.parameters, "imageSize") ?? option.imageSizes
    };
  });
}

export function imageModelOptionsFromNodeOptions(options: ModelOptionForNodeV1[], selectedModelId: string): ImageModelOption[] {
  const mapped = options.map((entry): ImageModelOption => ({
    id: entry.storedModelId,
    slug: entry.providerModelId,
    label: entry.displayName,
    provider: providerLabelForModelOption(entry),
    executionProvider: entry.executionProvider,
    capabilities: entry.capabilities,
    iconPath: entry.iconPath,
    parameters: entry.parameters,
    catalogModelId: entry.id,
    catalogProviderModelId: entry.providerModelId,
    aspectRatios: selectParameterValues(entry.parameters, "aspectRatio"),
    imageSizes: selectParameterValues(entry.parameters, "imageSize"),
    supportsImageGeneration: "supported",
    routeSupport: {
      openrouter: entry.executionProvider === "openrouter" ? "supported" : "unsupported",
      direct: entry.executionProvider === "gemini" ? "supported" : "unknown"
    },
    pricing: entry.pricing
  }));
  if (selectedModelId && !mapped.some((entry) => entry.id === selectedModelId)) {
    mapped.push({
      id: selectedModelId,
      slug: selectedModelId,
      label: selectedModelId,
      provider: selectedModelId.includes("/") ? providerFromSlug(selectedModelId) : "unknown",
      executionProvider: selectedModelId.includes("/") ? "openrouter" : undefined,
      capabilities: [],
      aspectRatios: imageAspectRatiosForSlug(selectedModelId),
      imageSizes: imageSizesForSlug(selectedModelId),
      supportsImageGeneration: "unknown",
      routeSupport: { openrouter: selectedModelId.includes("/") ? "unknown" : "unsupported", direct: "unknown" },
      disabled: true,
      note: "not in current catalog"
    });
  }
  return mapped;
}

export function polzaModelsFromNodeOptions(options: ModelOptionForNodeV1[], selectedModelId: string): PolzaModel[] {
  const mapped = options
    .filter((entry) => entry.provider === "polza" && entry.executionProvider === "polza" && !entry.storedModelId.startsWith("polza:"))
    .map((entry): PolzaModel => ({
      id: entry.storedModelId,
      name: entry.displayName,
      title: entry.displayName,
      providerId: entry.provider,
      capabilities: entry.capabilities,
      iconPath: entry.iconPath,
      catalogModelId: entry.id,
      catalogProviderModelId: entry.providerModelId,
      catalogParameters: entry.parameters,
      inputTypes: entry.inputTypes,
      outputTypes: entry.outputTypes,
      pricing: entry.pricing,
      short_description: entry.compatibilityReason,
      metadata: entry.metadata
    }));
  if (selectedModelId && !mapped.some((entry) => entry.id === selectedModelId)) {
    mapped.push({ id: selectedModelId, name: selectedModelId });
  }
  return mapped;
}

export function videoModelOptionsFromNodeOptions(options: ModelOptionForNodeV1[], selectedModelId: string): VideoModelOption[] {
  const mapped = options
    .filter((entry) => entry.provider === "polza" && entry.executionProvider === "polza" && !entry.storedModelId.startsWith("polza:"))
    .map((entry): VideoModelOption => ({
      id: entry.storedModelId,
      name: entry.displayName,
      providerId: "polza",
      providerLabel: "Polza.ai",
      pricing: entry.pricing,
      short_description: entry.compatibilityReason,
      architecture: { input_modalities: entry.inputTypes, output_modalities: entry.outputTypes },
      generationParameters: entry.parameters
    }));
  if (selectedModelId && !mapped.some((entry) => entry.id === selectedModelId)) {
    mapped.push({ id: selectedModelId, name: selectedModelId, providerId: "polza", providerLabel: "Polza.ai" });
  }
  return mapped;
}

export function modelOptionForNodeLogo(option: ModelOptionForNodeV1 | undefined): ModelLogo | undefined {
  if (!option?.iconPath) return undefined;
  return { id: option.iconKey || option.provider, label: option.displayName, src: `${apiBase}${option.iconPath}` };
}

export function modelOptionForNodeLabel(option: ModelOptionForNodeV1): string {
  return option.displayName === option.storedModelId ? option.storedModelId : `${option.displayName} (${option.storedModelId})`;
}

export function providerLabelForModelOption(option: ModelOptionForNodeV1): string {
  if (option.provider === "openrouter") return providerFromSlug(option.providerModelId);
  if (option.provider === "polza") return "Polza";
  if (option.provider === "rutronix") return "RuTronix";
  return option.provider;
}

export function enrichPolzaImageModelOptions(options: PolzaModel[], catalogModels: UnifiedModelInfo[]): PolzaModel[] {
  if (catalogModels.length === 0) return options;
  return options.flatMap((option) => {
    const catalogModel = catalogModels.find((entry) => catalogModelMatchesPolzaModel(entry, option));
    if (!catalogModel) return [option];
    if (catalogModelIsUpscaleOnly(catalogModel)) return [];
    return [{
      ...option,
      name: catalogModel.displayName || option.name,
      title: catalogModel.displayName || option.title,
      capabilities: catalogModel.capabilities ?? option.capabilities,
      iconPath: catalogModel.iconPath,
      catalogModelId: catalogModel.id,
      catalogProviderModelId: catalogModel.providerModelId,
      catalogParameters: catalogModel.parameters
    }];
  });
}

export function polzaProviderModelId(modelId: string): string {
  return modelId.startsWith("polza:") ? modelId.slice("polza:".length) : modelId;
}

export function catalogModelMatchesPolzaModel(catalogModel: UnifiedModelInfo, model: PolzaModel): boolean {
  return catalogModel.provider === "polza" && catalogModel.providerModelId === polzaProviderModelId(model.id);
}

export function catalogModelMatchesImageOption(catalogModel: UnifiedModelInfo, option: ImageModelOption): boolean {
  if (catalogModel.provider === "polza" && option.provider.toLowerCase() !== "polza") return false;
  return catalogModel.providerModelId === option.slug
    || catalogModel.providerModelId === option.id
    || catalogModel.id === option.id
    || Boolean(catalogModel.aliases?.includes(option.id));
}

export function catalogModelSupportsImageGenerate(catalogModel: UnifiedModelInfo): boolean {
  const capabilities = catalogModel.capabilities ?? [];
  return capabilities.includes("image.generate") && !capabilities.every((capability) => capability === "image.upscale");
}

export function catalogModelIsUpscaleOnly(catalogModel: UnifiedModelInfo): boolean {
  const capabilities = catalogModel.capabilities ?? [];
  return capabilities.includes("image.upscale") && !capabilities.some((capability) => capability.startsWith("image.") && capability !== "image.upscale");
}

export function selectParameterValues(parameters: UnifiedModelInfo["parameters"], parameterId: string): string[] | undefined {
  const parameter = parameters.find((entry) => entry.id === parameterId && entry.type === "select");
  return parameter?.options?.map((option) => option.value).filter(Boolean);
}

export function imageModelOptionLogo(model: ImageModelOption | undefined, fallbackModelId: string): ModelLogo {
  if (model?.iconPath) return { id: model.provider || "catalog", label: model.provider || "Model provider", src: `${apiBase}${model.iconPath}` };
  return modelLogoFor(model?.provider, model?.slug ?? fallbackModelId);
}

export function polzaImageModelLogo(model: PolzaModel | undefined, fallbackModelId: string): ModelLogo {
  if (model?.iconPath) return { id: "polza", label: model.name ?? model.title ?? "Polza", src: `${apiBase}${model.iconPath}` };
  return modelLogoFor("polza", model?.id ?? fallbackModelId);
}

export function imageModelOptionLabel(model: ImageModelOption): string {
  const notes = [model.disabled ? model.note : ""].filter(Boolean);
  return notes.length > 0 ? `${model.label} (${notes.join(", ")})` : model.label;
}

export function imageAspectRatioOptions(model: ImageModelOption | undefined): string[] {
  return model?.aspectRatios?.length ? model.aspectRatios : GEMINI_IMAGE_ASPECT_RATIOS;
}

export function imageSizeOptionsForModel(model: ImageModelOption | undefined): string[] {
  return model?.imageSizes?.length ? model.imageSizes : GEMINI_IMAGE_SIZES;
}

export function supportedOptionValue(value: unknown, options: string[]): string {
  const stringValue = typeof value === "string" ? value : "";
  return options.includes(stringValue) ? stringValue : options[0] ?? "";
}

export function imageAspectRatiosForSlug(slug: string): string[] {
  return isOpenAiImageSlug(slug) ? OPENAI_IMAGE_ASPECT_RATIOS : GEMINI_IMAGE_ASPECT_RATIOS;
}

export function imageSizesForSlug(slug: string): string[] {
  return isOpenAiImageSlug(slug) ? OPENAI_IMAGE_QUALITIES : GEMINI_IMAGE_SIZES;
}

export function isOpenAiImageSlug(slug: string): boolean {
  return slug.startsWith("openai/") && /image/i.test(slug);
}

export function connectionRouteHelper(route: string): string {
  if (route === "openrouter") return "Uses the selected OpenRouter model directly.";
  if (route === "direct") return "Bypasses OpenRouter and uses the provider's direct API configuration.";
  return "Automatically chooses a verified route. Unknown model support will not silently switch providers.";
}

export function imageRoutePreview(model: ImageModelOption | undefined, connectionRoute: string) {
  const selectedConnectionRoute = connectionRoute === "openrouter" ? "OpenRouter" : connectionRoute === "direct" ? "Direct API" : "Auto";
  if (!model) {
    return {
      selectedModelLabel: "Unknown model",
      selectedModelId: "",
      selectedConnectionRoute,
      resolvedProvider: "unresolved",
      resolvedRoute: "unresolved",
      supportsImageGeneration: "unknown",
      fallbackUsed: false,
      fallbackReason: ""
    };
  }
  const supportsImageGeneration = model.supportsImageGeneration;
  let resolvedProvider = "unresolved";
  let resolvedRoute = "unresolved";
  if (connectionRoute === "openrouter" && model.routeSupport.openrouter !== "unsupported") {
    resolvedProvider = "OpenRouter";
    resolvedRoute = model.routeSupport.openrouter === "unknown" ? "OpenRouter (manual, support unknown)" : "OpenRouter";
  } else if (connectionRoute === "direct" && model.routeSupport.direct === "supported") {
    resolvedProvider = model.provider;
    resolvedRoute = "Direct API";
  } else if (connectionRoute === "auto") {
    if (model.routeSupport.openrouter === "supported") {
      resolvedProvider = "OpenRouter";
      resolvedRoute = "OpenRouter";
    } else if (model.routeSupport.direct === "supported") {
      resolvedProvider = model.provider;
      resolvedRoute = "Direct API";
    }
  }
  return {
    selectedModelLabel: model.label,
    selectedModelId: model.slug,
    selectedConnectionRoute,
    resolvedProvider,
    resolvedRoute,
    supportsImageGeneration,
    fallbackUsed: false,
    fallbackReason: ""
  };
}

export function providerFromSlug(slug: string): string {
  const provider = slug.split("/")[0] || "unknown";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function openRouterCostLabel(model: OpenRouterModel | undefined): string {
  return model?.pricingHint ? `Pricing: ${model.pricingHint}` : "";
}

export function imageModelCostLabel(model: ImageModelOption | undefined): string {
  if (!model) return "";
  if (model.executionProvider === "openrouter") return `Route: OpenRouter · Owner: ${model.provider}`;
  if (model.executionProvider === "gemini") return `Route: Direct API · Provider: ${model.provider}`;
  return model.provider ? `Provider: ${model.provider}` : "";
}

