export type ContentKind = "image" | "video" | "text" | "audio";
export type ModelRole = "image-upscaler" | "video-upscaler";
export type GenerationParameterValue = string | number | boolean;
export type ImageGenerationParameters = Record<string, GenerationParameterValue>;

export interface ModelParameterDefinition {
  id: string;
  label: string;
  type: "select" | "number" | "text" | "boolean";
  default?: GenerationParameterValue;
  options?: Array<{ value: string; label?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ModelOption {
  id: string;
  title: string;
  providerId: string;
  iconPath?: string;
  iconKey?: string;
  originVendor?: string;
  contentKinds: ContentKind[];
  accepts: ContentKind[];
  produces: ContentKind[];
  capabilities: string[];
  paramsSchema?: ModelParameterDefinition[];
  isAvailable: boolean;
  statusReason?: string;
  source?: string;
  acceptsImageInput?: boolean;
  maxImageInputs?: number;
  imageReferenceSyntax?: string;
  generationParameters?: ModelParameterDefinition[];
  defaultParameters?: ImageGenerationParameters;
  role?: ModelRole;
}

type ModelOptionForNodeResponse = {
  ok?: boolean;
  models?: unknown;
};

type ServerModelOptionForNode = {
  id: string;
  provider: string;
  providerModelId: string;
  displayName: string;
  iconPath: string;
  inputTypes: string[];
  outputTypes: string[];
  capabilities: string[];
  roles: string[];
  parameters: ModelParameterDefinition[];
  nodeType: string;
  storedModelId: string;
  executionProvider: string;
  compatibilityReason?: string;
};

type ServerModelCatalogEntry = {
  id: string;
  provider: string;
  providerModelId: string;
  originVendor?: string;
  displayName: string;
  iconKey?: string;
  iconPath?: string;
  inputTypes: string[];
  outputTypes: string[];
  capabilities: string[];
  roles: string[];
  parameters: ModelParameterDefinition[];
  availability?: { status?: string; reason?: string };
};

export interface ProviderSettings {
  replicate?: { configured?: boolean };
  gemini?: { configured?: boolean };
  polza?: { configured?: boolean };
  openai?: { configured?: boolean };
  seedance?: { configured?: boolean };
  openrouter?: { configured?: boolean };
}

export interface ModelCatalogResult {
  models: ModelOption[];
  availableModels: ModelOption[];
  errors: Partial<Record<string, string>>;
}

export interface DisplayModelOption {
  model: ModelOption;
  providers: string[];
  routes: ModelOption[];
}

export interface ModelRouteSelection {
  modelId: string;
  executionProvider: string;
  fallbackAllowed: boolean;
}

export type ModelCatalogGroup = ContentKind | ModelRole;

const knownTextOnlyModelIds = new Set([
  "openai/gpt-5.1",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.2",
  "openai/gpt-5.2-chat"
]);

export const fallbackModels: ModelOption[] = [{
  id: "image.nano-banana",
  title: "Nano Banana",
  providerId: "gemini",
  contentKinds: ["image"],
  accepts: ["text", "image"],
  produces: ["image"],
  capabilities: ["image.generate", "image.reference"],
  isAvailable: true,
  source: "fallback",
  acceptsImageInput: true,
  generationParameters: fallbackGeminiParameters(),
  paramsSchema: fallbackGeminiParameters()
}];

export async function loadModelCatalog(
  getJson: (path: string) => Promise<unknown>,
  settings: ProviderSettings | null
): Promise<ModelCatalogResult> {
  const errors: Partial<Record<string, string>> = {};
  const nodeSources = [
    { nodeType: "ai.image.generate", fallbackKind: "image" as const },
    { nodeType: "ai.text", fallbackKind: "text" as const }
  ];
  const loaded: ModelOption[] = [];
  let availableModels: ModelOption[] = [];
  try {
    availableModels = normalizeAvailableModelOptions(await getJson("/api/models/v1"));
    if (availableModels.length === 0) errors["models.v1"] = "Server model catalog returned no usable available models.";
  } catch (error) {
    errors["models.v1"] = error instanceof Error ? error.message : "Available model catalog request failed.";
  }
  if (availableModels.length > 0) {
    const catalog = mergeModelOptions(availableModels);
    return {
      models: catalog,
      availableModels: catalog,
      errors
    };
  }
  for (const source of nodeSources) {
    try {
      const response = await getJson(`/api/models/for-node/${encodeURIComponent(source.nodeType)}`);
      const normalized = normalizeNodeModelOptions(response, source.nodeType);
      if (normalized.length > 0) {
        loaded.push(...normalized);
        continue;
      }
      errors[source.nodeType] = "Server model catalog returned no usable models.";
    } catch (error) {
      try {
        loaded.push(...await loadLegacyFallbackModels(getJson, settings, source.fallbackKind));
      } catch {
        errors[source.nodeType] = error instanceof Error ? error.message : "Catalog request failed.";
      }
    }
  }
  const selectorModels = mergeModelOptions([...fallbackModels, ...configuredBuiltInModels(settings), ...loaded]);
  return {
    models: selectorModels,
    availableModels: availableModels.length ? mergeModelOptions(availableModels) : selectorModels,
    errors
  };
}

export function modelsForContentKind(models: ModelOption[], kind: ContentKind): ModelOption[] {
  return models.filter((model) => modelMatchesCatalogGroup(model, kind));
}

export function modelsForPickerContentKind(models: ModelOption[], value: unknown): ModelOption[] {
  const kind = pickerContentKind(value);
  return kind ? modelsForContentKind(models, kind) : [];
}

export function mergeProviderAndUserDefinedPickerModels(providerCatalogModels: ModelOption[], userDefinedModels: ModelOption[]): ModelOption[] {
  const compatibleUserModels = userDefinedModels.filter((model) =>
    model.source === "custom-link"
    && model.isAvailable
    && model.produces.length > 0
  );
  return mergeModelOptions([...providerCatalogModels, ...compatibleUserModels]);
}

export function pickerContentKind(value: unknown): ContentKind | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "image" || normalized === "picture" || normalized === "still") return "image";
  if (normalized === "video" || normalized === "movingimage" || normalized === "clip" || normalized === "movie") return "video";
  if (normalized === "text" || normalized === "prompt" || normalized === "document") return "text";
  if (normalized === "audio" || normalized === "sound") return "audio";
  return undefined;
}

export function modelMatchesCatalogGroup(model: ModelOption, group: ModelCatalogGroup): boolean {
  if (!model.isAvailable) return false;
  if (group === "image-upscaler") return model.role === "image-upscaler" && model.produces.includes("image");
  if (group === "video-upscaler") return model.role === "video-upscaler" && model.produces.includes("video");
  if (model.role) return false;
  if (group === "text") return model.produces.includes("text") && !model.produces.includes("image") && !model.produces.includes("video");
  if (group === "image") return model.produces.includes("image");
  if (group === "video") return model.produces.includes("video");
  return model.produces.includes(group);
}

export function modelsCompatibleWithNodeInputs(models: ModelOption[], kind: ContentKind, hasImageInput: boolean): ModelOption[] {
  if (!hasImageInput || kind === "image") return models;
  return models.filter((model) => model.accepts.includes("image") || model.acceptsImageInput === true);
}

export function modelImageInputLimit(model: Pick<ModelOption, "accepts" | "acceptsImageInput" | "maxImageInputs">): number | undefined {
  return model.accepts.includes("image") || model.acceptsImageInput === true ? model.maxImageInputs : 0;
}

export function modelSelectionId(model: ModelOption | undefined): string {
  return model ? `${model.providerId}:${model.id}` : "";
}

export function mergeModelsForDisplay(models: ModelOption[]): DisplayModelOption[] {
  const entries = new Map<string, DisplayModelOption>();
  for (const model of models) {
    const key = model.id.toLowerCase();
    const existing = entries.get(key);
    if (existing) {
      if (!existing.providers.includes(model.providerId)) {
        existing.providers.push(model.providerId);
        existing.routes.push(model);
      }
      continue;
    }
    entries.set(key, { model, providers: [model.providerId], routes: [model] });
  }
  return [...entries.values()];
}

export function providerDisplayName(providerId: string): string {
  const names: Record<string, string> = {
    polza: "polza.ai",
    openrouter: "OpenRouter",
    gemini: "Gemini",
    replicate: "Replicate",
    openai: "OpenAI",
    seedance: "Seedance"
  };
  return names[providerId.toLowerCase()] ?? providerId;
}

export function normalizeModelOptions(value: unknown, providerId: string): ModelOption[] {
  const candidates = collectModelCandidates(value);
  const seen = new Set<string>();
  return candidates.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? record.modelId ?? record.slug ?? record.name ?? "");
    const entryProviderId = String(record.providerId ?? record.provider ?? providerId);
    if (isProviderRoutingAlias(entryProviderId, id)) return [];
    const seenKey = `${entryProviderId}:${id}`;
    if (!id || seen.has(seenKey)) return [];
    seen.add(seenKey);
    const produces = inferProducedKinds(record, providerId);
    if (produces.length === 0) return [];
    const role = inferModelRole(record, produces);
    const accepts = inferAcceptedKinds(record);
    const generationParameters = modelGenerationParameterDefinitions(record);
    return [{
      id,
      title: String(record.title ?? record.label ?? record.displayName ?? record.name ?? id),
      providerId: entryProviderId,
      contentKinds: produces,
      accepts,
      produces,
      capabilities: inferCapabilities(record, produces),
      paramsSchema: generationParameters,
      source: providerId,
      isAvailable: record.isAvailable !== false,
      statusReason: typeof record.statusReason === "string" ? record.statusReason : undefined,
      acceptsImageInput: modelAcceptsImageInput(record),
      maxImageInputs: modelMaxImageInputs(record),
      imageReferenceSyntax: modelImageReferenceSyntax(record),
      generationParameters,
      defaultParameters: modelDefaultGenerationParameters(record),
      role
    }];
  });
}

export function modelGenerationParameters(model: ModelOption): ImageGenerationParameters {
  const schemaDefaults = Object.fromEntries(
    (model.generationParameters ?? []).flatMap((definition) => definition.default === undefined ? [] : [[definition.id, definition.default]])
  );
  return { ...schemaDefaults, ...(model.defaultParameters ?? {}) };
}

export function generationParameterSummary(definitions: ModelParameterDefinition[], values: ImageGenerationParameters): string {
  if (definitions.length === 0) return "No parameters";
  return definitions.slice(0, 2).map((definition) => String(values[definition.id] ?? definition.default ?? "")).filter(Boolean).join(" / ") || "Parameters";
}

export function normalizeNodeModelOptions(value: unknown, nodeType: string): ModelOption[] {
  const response = value as ModelOptionForNodeResponse;
  const candidates = Array.isArray(response?.models) ? response.models : [];
  return candidates.flatMap((entry) => {
    if (!isServerModelOptionForNode(entry, nodeType)) return [];
    const produces = entry.outputTypes.flatMap(contentKind);
    if (produces.length === 0) return [];
    const accepts = entry.inputTypes.flatMap(contentKind);
    const generationParameters = normalizeServerParameterDefinitions(entry.parameters);
    return [{
      id: entry.storedModelId,
      title: entry.displayName,
      providerId: entry.executionProvider || entry.provider,
      iconPath: entry.iconPath,
      contentKinds: produces,
      accepts: accepts.length ? [...new Set(accepts)] : ["text"],
      produces: [...new Set(produces)],
      capabilities: entry.capabilities,
      paramsSchema: generationParameters,
      source: nodeType,
      isAvailable: true,
      acceptsImageInput: entry.inputTypes.includes("image"),
      generationParameters,
      defaultParameters: Object.fromEntries(generationParameters.flatMap((definition) => definition.default === undefined ? [] : [[definition.id, definition.default]])),
      role: entry.roles.includes("upscaler") ? produces.includes("video") ? "video-upscaler" : "image-upscaler" : undefined
    }];
  });
}

export function normalizeAvailableModelOptions(value: unknown): ModelOption[] {
  const response = value as ModelOptionForNodeResponse;
  const candidates = Array.isArray(response?.models) ? response.models : [];
  return candidates.flatMap((entry) => {
    if (!isServerModelCatalogEntry(entry)) return [];
    const produces = normalizeCatalogOutputKinds(entry.providerModelId, entry.outputTypes);
    if (produces.length === 0) return [];
    const accepts = entry.inputTypes.flatMap(contentKind);
    const generationParameters = normalizeServerParameterDefinitions(entry.parameters);
    return [{
      id: entry.providerModelId,
      title: entry.displayName,
      providerId: entry.provider,
      iconPath: usableIconPath(entry.iconPath)
        ?? catalogIconPath(entry.iconKey)
        ?? catalogIconPath(entry.originVendor)
        ?? catalogIconPath(entry.provider)
        ?? catalogIconPath("unknown"),
      iconKey: entry.iconKey,
      originVendor: entry.originVendor,
      contentKinds: [...new Set(produces)],
      accepts: accepts.length ? [...new Set(accepts)] : ["text"],
      produces: [...new Set(produces)],
      capabilities: entry.capabilities,
      paramsSchema: generationParameters,
      source: "models.v1",
      isAvailable: entry.availability?.status !== "unavailable",
      statusReason: typeof entry.availability?.reason === "string" ? entry.availability.reason : undefined,
      acceptsImageInput: entry.inputTypes.includes("image"),
      generationParameters,
      defaultParameters: Object.fromEntries(generationParameters.flatMap((definition) => definition.default === undefined ? [] : [[definition.id, definition.default]])),
      role: entry.roles.includes("upscaler") ? produces.includes("video") ? "video-upscaler" : "image-upscaler" : undefined
    }];
  });
}

async function loadLegacyFallbackModels(
  getJson: (path: string) => Promise<unknown>,
  settings: ProviderSettings | null,
  kind: "image" | "text"
): Promise<ModelOption[]> {
  const sources = kind === "image"
    ? [
      { endpoint: "/api/models?provider=openrouter&capability=image.generate", fallbackEndpoint: "/api/providers/openrouter/models", providerId: "openrouter", configured: Boolean(settings?.openrouter?.configured) },
      { endpoint: "/api/models?provider=polza&capability=image.generate", fallbackEndpoint: "/api/providers/polza/models?type=image", providerId: "polza", configured: Boolean(settings?.polza?.configured) }
    ]
    : [
      { endpoint: "/api/models?provider=openrouter&capability=text.generate", fallbackEndpoint: "/api/providers/openrouter/models", providerId: "openrouter", configured: Boolean(settings?.openrouter?.configured) },
      { endpoint: "/api/models?provider=polza&capability=text.generate", fallbackEndpoint: "/api/providers/polza/models?type=chat", providerId: "polza", configured: Boolean(settings?.polza?.configured) }
    ];
  const loaded: ModelOption[] = [];
  for (const source of sources) {
    if (!source.configured) continue;
    try {
      const response = await getJson(source.endpoint);
      const normalized = normalizeModelOptions(response, source.providerId);
      if (normalized.length > 0) {
        loaded.push(...normalized);
        continue;
      }
      const fallback = await getJson(source.fallbackEndpoint);
      loaded.push(...normalizeModelOptions(fallback, source.providerId));
    } catch {
      const fallback = await getJson(source.fallbackEndpoint);
      loaded.push(...normalizeModelOptions(fallback, source.providerId));
    }
  }
  return loaded;
}

function isServerModelOptionForNode(value: unknown, nodeType: string): value is ServerModelOptionForNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.provider === "string"
    && typeof record.providerModelId === "string"
    && typeof record.displayName === "string"
    && Array.isArray(record.inputTypes)
    && Array.isArray(record.outputTypes)
    && Array.isArray(record.capabilities)
    && Array.isArray(record.roles)
    && Array.isArray(record.parameters)
    && record.nodeType === nodeType
    && typeof record.storedModelId === "string"
    && typeof record.executionProvider === "string";
}

function isServerModelCatalogEntry(value: unknown): value is ServerModelCatalogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.provider === "string"
    && typeof record.providerModelId === "string"
    && typeof record.displayName === "string"
    && typeof record.iconPath === "string"
    && Array.isArray(record.inputTypes)
    && Array.isArray(record.outputTypes)
    && Array.isArray(record.capabilities)
    && Array.isArray(record.roles)
    && Array.isArray(record.parameters);
}

function normalizeServerParameterDefinitions(parameters: ModelParameterDefinition[]): ModelParameterDefinition[] {
  return parameters.flatMap((definition) => {
    const id = stringParameter(definition.id);
    if (!id) return [];
    const type: ModelParameterDefinition["type"] = definition.type === "number" || definition.type === "text" || definition.type === "boolean" ? definition.type : "select";
    return [{
      id,
      label: stringParameter(definition.label) ?? id,
      type,
      default: parameterValue(definition.default),
      options: Array.isArray(definition.options) ? definition.options.flatMap((option) => {
        const value = stringParameter(option.value);
        return value ? [{ value, label: stringParameter(option.label) }] : [];
      }) : undefined,
      min: numberParameter(definition.min),
      max: numberParameter(definition.max),
      step: numberParameter(definition.step)
    }];
  });
}

function isProviderRoutingAlias(providerId: string, modelId: string): boolean {
  const provider = providerId.toLowerCase();
  const model = modelId.toLowerCase();
  return provider === "openrouter" && (model === "openrouter/auto" || model === "auto");
}

function mergeModelOptions(options: ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const option of options) {
    const key = modelSelectionId(option);
    if (!byId.has(key)) byId.set(key, option);
  }
  return [...byId.values()];
}

function collectModelCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["models", "imageModels", "providerModels", "connectedModels", "availableModels", "items"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return Object.values(record).flatMap((item) => collectModelCandidates(item));
}

function inferProducedKinds(record: Record<string, unknown>, providerId: string): ContentKind[] {
  const explicitType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const architecture = objectValue(record.architecture);
  const outputModalities = [
    architecture.output_modalities,
    record.outputTypes,
    record.outputModalities,
    record.outputs,
    record.produces
  ].flatMap((field) => Array.isArray(field) ? field : [field]).filter(Boolean).map(String).join(" ").toLowerCase();
  const explicitOutputs: ContentKind[] = [];
  if (/(video|text-to-video|image-to-video|video-generation)/.test(outputModalities)) explicitOutputs.push("video");
  if (/(image|img|text-to-image|image-generation)/.test(outputModalities)) explicitOutputs.push("image");
  if (/(audio|speech|music|sound)/.test(outputModalities)) explicitOutputs.push("audio");
  const textOutputModalities = outputModalities.replace(/(?:text|image)-to-(?:image|video|audio)/g, "");
  if (/(^|[\s,_-])(text|chat|language|message)([\s,_-]|$)/.test(textOutputModalities)) explicitOutputs.push("text");
  if (explicitOutputs.length) return [...new Set(explicitOutputs)];
  if (explicitType === "video") return ["video"];
  if (explicitType === "image") return ["image"];
  if (explicitType === "chat" || explicitType === "text") return ["text"];
  if (explicitType === "audio") return ["audio"];
  const text = modelOutputMetadataText(record);
  if (/(video|text-to-video|image-to-video|video-generation)/.test(text)) return ["video"];
  if (/(image|img|vision|visual|text-to-image|image-generation)/.test(text)) return ["image"];
  if (/(audio|speech|music|sound)/.test(text)) return ["audio"];
  if (/(text|chat|language|embedding)/.test(text)) return ["text"];
  // OpenRouter cache entries can be minimal, while its default gateway route is text generation.
  if (providerId === "openrouter") return ["text"];
  return [];
}

function inferModelRole(record: Record<string, unknown>, produces: ContentKind[]): ModelRole | undefined {
  const text = modelMetadataText(record);
  if (!/(upscale|upscaler|super[- ]?resolution|enhance)/.test(text)) return undefined;
  return produces.includes("video") || /video/.test(text) ? "video-upscaler" : "image-upscaler";
}

function configuredBuiltInModels(settings: ProviderSettings | null): ModelOption[] {
  return settings?.replicate?.configured ? [{
    id: "philz1337x/clarity-upscaler",
    title: "Clarity Upscaler",
    providerId: "replicate",
    contentKinds: ["image"],
    accepts: ["image"],
    produces: ["image"],
    capabilities: ["image.upscale"],
    source: "bundled",
    isAvailable: true,
    acceptsImageInput: true,
    maxImageInputs: 1,
    role: "image-upscaler"
  }] : [];
}

function inferAcceptedKinds(record: Record<string, unknown>): ContentKind[] {
  const architecture = objectValue(record.architecture);
  const values = [
    ...(Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : []),
    ...(Array.isArray(record.inputTypes) ? record.inputTypes.map(String) : [])
  ];
  const matched = values.flatMap((value) => contentKind(value));
  if (matched.length) return [...new Set([...matched, ...(modelAcceptsImageInput(record) ? ["image" as const] : [])])];
  return modelAcceptsImageInput(record) ? ["text", "image"] : ["text"];
}

function inferCapabilities(record: Record<string, unknown>, produces: ContentKind[]): string[] {
  const explicit = Array.isArray(record.capabilities) ? record.capabilities.map(String) : [];
  return [...new Set([...explicit, ...produces.map((kind) => `${kind}.generate`)])];
}

function modelMetadataText(record: Record<string, unknown>): string {
  const architecture = objectValue(record.architecture);
  const metadata = objectValue(record.metadata);
  return [
    record.nodeTypes, record.nodeType, record.type, record.capabilities, record.modalities,
    record.inputModalities, record.outputModalities, architecture.input_modalities,
    architecture.output_modalities, architecture.modality, record.tasks, record.kind,
    record.category, record.family, record.description, metadata.description,
    metadata.supportedFrameImageModes, metadata.supportedParameters, record.id
  ].flatMap((field) => Array.isArray(field) ? field : [field]).filter(Boolean).map(String).join(" ").toLowerCase();
}

function modelOutputMetadataText(record: Record<string, unknown>): string {
  const architecture = objectValue(record.architecture);
  const metadata = objectValue(record.metadata);
  return [
    record.nodeTypes, record.nodeType, record.type, record.outputModalities, architecture.output_modalities,
    record.outputTypes, record.outputs, record.produces, record.tasks, record.kind, record.category, record.family,
    record.description, metadata.description, record.id
  ].flatMap((field) => Array.isArray(field) ? field : [field]).filter(Boolean).map(String).join(" ").toLowerCase();
}

function contentKind(value: string): ContentKind[] {
  const kind = pickerContentKind(value);
  return kind ? [kind] : [];
}

function normalizeCatalogOutputKinds(modelId: string, outputTypes: string[]): ContentKind[] {
  const produces = outputTypes.flatMap(contentKind);
  return knownTextOnlyModelIds.has(modelId.toLowerCase()) && produces.includes("text") ? ["text"] : produces;
}

function usableIconPath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function catalogIconPath(key: unknown): string | undefined {
  if (typeof key !== "string" || !key.trim()) return undefined;
  return `/api/model-icons/${catalogIconFilename(key)}`;
}

function catalogIconFilename(key: string): string {
  const normalized = key.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const filenames: Record<string, string> = {
    "black-forest-labs": "flux-2-pro.png",
    bytedance: "seedream-4-5.png",
    gemini: "gemini.png",
    google: "gemini.png",
    gpt: "gpt.png",
    "nano-banana": "gemini.png",
    openai: "gpt.png",
    unknown: "unknown.svg",
    xai: "grok-image.png",
    yandex: "yandexart.png"
  };
  return filenames[normalized] ?? `${normalized}.svg`;
}

function modelAcceptsImageInput(record: Record<string, unknown>): boolean {
  const architecture = objectValue(record.architecture);
  const metadata = objectValue(record.metadata);
  const provider = objectValue(record.top_provider);
  const parameters = objectValue(provider.parameters);
  const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : [];
  const inputTypes = Array.isArray(record.inputTypes) ? record.inputTypes.map(String) : [];
  if ([...inputModalities, ...inputTypes].some((modality) => modality.toLowerCase() === "image") || Object.hasOwn(parameters, "images")) return true;
  if (positiveNumber(record.maxImageInputs) || positiveNumber(metadata.maxImageInputs)) return true;
  if (Array.isArray(record.supported_frame_image_modes) && record.supported_frame_image_modes.length > 0) return true;
  if (Array.isArray(metadata.supportedFrameImageModes) && metadata.supportedFrameImageModes.length > 0) return true;
  const searchable = modelMetadataText(record);
  return /\bimage[- ]to[- ]video\b|\bimage inputs?\b|\bimage references?\b|\bfirst frame\b|\blast frame\b/.test(searchable);
}

function modelMaxImageInputs(record: Record<string, unknown>): number | undefined {
  const metadata = objectValue(record.metadata);
  const direct = Number(record.maxImageInputs ?? record.maxImages);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const metadataDirect = Number(metadata.maxImageInputs ?? metadata.maxImages);
  if (Number.isInteger(metadataDirect) && metadataDirect > 0) return metadataDirect;
  const inputs = Array.isArray(objectValue(record.ioContract).inputs) ? objectValue(record.ioContract).inputs as unknown[] : [];
  const imageInput = inputs.find((input) => objectValue(input).kind === "image");
  const contracted = Number(objectValue(imageInput).maxItems);
  return Number.isInteger(contracted) && contracted > 0 ? contracted : undefined;
}

function modelImageReferenceSyntax(record: Record<string, unknown>): string | undefined {
  const value = record.imageReferenceSyntax ?? record.image_reference_syntax;
  return typeof value === "string" && value.includes("{index}") ? value : undefined;
}

function modelGenerationParameterDefinitions(record: Record<string, unknown>): ModelParameterDefinition[] | undefined {
  const metadata = objectValue(record.metadata);
  const sourceParameters = Array.isArray(record.generationParameters)
    ? record.generationParameters
    : Array.isArray(metadata.generationParameters) ? metadata.generationParameters : undefined;
  if (!sourceParameters) return undefined;
  const definitions = sourceParameters.flatMap((source) => {
    const definition = objectValue(source);
    const id = stringParameter(definition.id);
    const label = stringParameter(definition.label);
    if (!id || !label) return [];
    const type: ModelParameterDefinition["type"] = definition.type === "number" || definition.type === "text" ? definition.type : "select";
    const options = Array.isArray(definition.options) ? definition.options.flatMap((entry) => {
      const option = objectValue(entry);
      const value = stringParameter(option.value);
      return value ? [{ value, label: stringParameter(option.label) }] : [];
    }) : undefined;
    return [{ id, label, type, default: parameterValue(definition.default), options, min: numberParameter(definition.min), max: numberParameter(definition.max), step: numberParameter(definition.step) }];
  });
  return definitions.length ? definitions : [];
}

function modelDefaultGenerationParameters(record: Record<string, unknown>): ImageGenerationParameters | undefined {
  const source = objectValue(record.defaultParameters ?? record.defaultParams);
  const entries = Object.entries(source).flatMap(([key, value]) => {
    const parameter = parameterValue(value);
    return parameter === undefined ? [] : [[key, parameter] as [string, GenerationParameterValue]];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function fallbackGeminiParameters(): ModelParameterDefinition[] {
  return [
    { id: "aspectRatio", label: "Aspect ratio", type: "select", default: "1:1", options: ["1:1", "3:2", "2:3", "16:9", "9:16"].map((value) => ({ value })) },
    { id: "imageSize", label: "Resolution", type: "select", default: "2K", options: ["1K", "2K", "4K"].map((value) => ({ value })) }
  ];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringParameter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParameter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): boolean {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0;
}

function parameterValue(value: unknown): GenerationParameterValue | undefined {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
