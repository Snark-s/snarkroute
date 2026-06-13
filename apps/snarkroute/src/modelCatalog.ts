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
  providerModelId?: string;
  storedModelId?: string;
  iconPath?: string;
  iconKey?: string;
  originVendor?: string;
  inputTypes?: string[];
  outputTypes?: string[];
  roles?: string[];
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
  metadata?: Record<string, unknown>;
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

export async function loadModelCatalog(
  getJson: (path: string) => Promise<unknown>,
  _settings: ProviderSettings | null
): Promise<ModelCatalogResult> {
  const errors: Partial<Record<string, string>> = {};
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
  return {
    models: [],
    availableModels: [],
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
  const outputTypes = catalogOutputKinds(model);
  const roles = catalogRoles(model);
  if (group === "image-upscaler") return outputTypes.includes("image") && roles.includes("upscaler");
  if (group === "video-upscaler") return outputTypes.includes("video") && roles.includes("upscaler");
  if (roles.includes("upscaler")) return false;
  if (group === "text") return outputTypes.includes("text") && !outputTypes.includes("image") && !outputTypes.includes("video");
  if (group === "image") return outputTypes.includes("image");
  if (group === "video") return outputTypes.includes("video");
  return outputTypes.includes(group);
}

export function modelsCompatibleWithNodeInputs(models: ModelOption[], kind: ContentKind, hasImageInput: boolean): ModelOption[] {
  if (!hasImageInput || kind === "image" || kind === "video") return models;
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
      providerModelId: entry.providerModelId,
      storedModelId: entry.storedModelId,
      iconPath: entry.iconPath,
      inputTypes: entry.inputTypes,
      outputTypes: entry.outputTypes,
      roles: entry.roles,
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
    const produces = entry.outputTypes.flatMap(contentKind);
    if (produces.length === 0) return [];
    const accepts = entry.inputTypes.flatMap(contentKind);
    const generationParameters = normalizeServerParameterDefinitions(entry.parameters);
    const metadata = entry.metadata ?? {};
    return [{
      id: entry.providerModelId,
      title: entry.displayName,
      providerId: entry.provider,
      providerModelId: entry.providerModelId,
      storedModelId: entry.providerModelId,
      iconPath: resolvedCatalogIconPath(entry.iconPath, entry.iconKey, entry.originVendor, entry.providerModelId, entry.provider),
      iconKey: entry.iconKey,
      originVendor: entry.originVendor,
      inputTypes: entry.inputTypes,
      outputTypes: entry.outputTypes,
      roles: entry.roles,
      contentKinds: [...new Set(produces)],
      accepts: accepts.length ? [...new Set(accepts)] : ["text"],
      produces: [...new Set(produces)],
      capabilities: entry.capabilities,
      paramsSchema: generationParameters,
      source: "models.v1",
      isAvailable: entry.availability?.status !== "unavailable",
      statusReason: typeof entry.availability?.reason === "string" ? entry.availability.reason : undefined,
      acceptsImageInput: entry.inputTypes.includes("image"),
      maxImageInputs: positiveInteger(metadata.maxImageInputs) ?? positiveInteger(metadata.maxImages),
      imageReferenceSyntax: stringParameter(metadata.imageReferenceSyntax),
      generationParameters,
      defaultParameters: Object.fromEntries(generationParameters.flatMap((definition) => definition.default === undefined ? [] : [[definition.id, definition.default]])),
      role: entry.roles.includes("upscaler") ? produces.includes("video") ? "video-upscaler" : "image-upscaler" : undefined
    }];
  });
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

function mergeModelOptions(options: ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const option of options) {
    const key = modelSelectionId(option);
    if (!byId.has(key)) byId.set(key, option);
  }
  return [...byId.values()];
}

function contentKind(value: string): ContentKind[] {
  const kind = pickerContentKind(value);
  return kind ? [kind] : [];
}

function catalogOutputKinds(model: ModelOption): ContentKind[] {
  const kinds = Array.isArray(model.outputTypes) ? model.outputTypes.flatMap(contentKind) : [];
  return kinds.length ? [...new Set(kinds)] : model.produces;
}

function catalogRoles(model: ModelOption): string[] {
  const roles = Array.isArray(model.roles) ? model.roles.filter((role): role is string => typeof role === "string") : [];
  if (roles.length) return roles;
  if (model.role === "image-upscaler" || model.role === "video-upscaler") return ["upscaler"];
  return [];
}

function resolvedCatalogIconPath(iconPath: unknown, iconKey: unknown, originVendor: unknown, providerModelId: unknown, provider: unknown): string {
  const providerIconKey = sameIconKey(iconKey, provider);
  const identityPath = catalogIconPath(providerModelId);
  return usableIconPath(iconPath, provider)
    ?? (!providerIconKey ? catalogIconPath(iconKey) : undefined)
    ?? catalogIconPath(originVendor)
    ?? identityPath
    ?? catalogIconPath("unknown")
    ?? "/api/model-icons/unknown.svg";
}

function sameIconKey(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return normalizedIconKey(left) === normalizedIconKey(right);
}

function usableIconPath(value: unknown, provider: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const path = value.trim();
  if (!path.startsWith("/api/model-icons/")) return path;
  const filename = decodeURIComponent(path.slice("/api/model-icons/".length));
  if (filename === catalogIconFilename(String(provider))) return undefined;
  return knownModelIconFilenames.has(filename) ? path : undefined;
}

function catalogIconPath(key: unknown): string | undefined {
  if (typeof key !== "string" || !key.trim()) return undefined;
  const filename = catalogIconFilename(key);
  return filename ? `/api/model-icons/${filename}` : undefined;
}

function catalogIconFilename(key: string): string | undefined {
  const filenames: Record<string, string> = {
    anthropic: "claude.png",
    "black-forest-labs": "flux-2-pro.png",
    bytedance: "seedream-4-5.png",
    claude: "claude.png",
    gemini: "gemini.png",
    google: "gemini.png",
    gpt: "gpt.png",
    local: "local.svg",
    kling: "kling.png",
    kwaivgi: "kling.png",
    kuaishou: "kling.png",
    minimax: "hailuo.png",
    hailuo: "hailuo.png",
    "nano-banana": "nano-banana.svg",
    "image.nano-banana": "nano-banana.svg",
    "google/gemini-3.1-flash-image-preview": "nano-banana.svg",
    "google/gemini-3-pro-image-preview": "nano-banana.svg",
    openai: "gpt.png",
    openrouter: "openrouter.svg",
    polza: "polza.svg",
    qwen: "qwen.png",
    replicate: "replicate.svg",
    seedance: "seedream-4-5.png",
    seedream: "seedream-4-5.png",
    "seedream-4-5": "seedream-4-5.png",
    stability: "stability.svg",
    topaz: "topaz.svg",
    unknown: "unknown.svg",
    wan: "wan.svg",
    "x-ai": "grok-image.png",
    xai: "grok-image.png",
    grok: "grok-image.png",
    "z-ai": "z-image.png",
    zai: "z-image.png",
    "z-image": "z-image.png",
    "tongyi-mai": "z-image.png",
    yandex: "yandexart.png"
  };
  for (const candidate of iconKeyCandidates(key)) {
    const filename = filenames[candidate];
    if (filename) return filename;
  }
  return undefined;
}

function normalizedIconKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function iconKeyCandidates(value: string): string[] {
  const normalized = normalizedIconKey(value);
  const upstream = normalized.split("/")[0];
  return upstream && upstream !== normalized ? [normalized, upstream] : [normalized];
}

const knownModelIconFilenames = new Set([
  "claude.png",
  "cohere.svg",
  "comfyui.svg",
  "deepseek.png",
  "elevenlabs.svg",
  "flux-2-pro.png",
  "gemini.png",
  "gpt.png",
  "grok-image.png",
  "hailuo.png",
  "huggingface.svg",
  "kling.png",
  "leonardo.svg",
  "llama.png",
  "local.svg",
  "luma.svg",
  "midjourney.svg",
  "mistral.svg",
  "nano-banana.svg",
  "nvidia.svg",
  "ollama.svg",
  "openrouter.svg",
  "perplexity.svg",
  "pika.png",
  "polza.svg",
  "qwen.png",
  "replicate.svg",
  "runway.png",
  "seedream-4-5.png",
  "sora.png",
  "stability.svg",
  "suno.svg",
  "topaz.svg",
  "unknown.svg",
  "veo.png",
  "wan.svg",
  "yandexart.png",
  "z-image.png"
]);

function stringParameter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParameter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function parameterValue(value: unknown): GenerationParameterValue | undefined {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
