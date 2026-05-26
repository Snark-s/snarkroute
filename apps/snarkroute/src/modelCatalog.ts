export type ContentKind = "image" | "video" | "text" | "audio";
export type ModelRole = "image-upscaler" | "video-upscaler";
export type GenerationParameterValue = string | number | boolean;
export type ImageGenerationParameters = Record<string, GenerationParameterValue>;

export interface ModelParameterDefinition {
  id: string;
  label: string;
  type: "select" | "number" | "text";
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
  const sources = [
    { endpoint: "/api/providers/openrouter/models", providerId: "openrouter", configured: Boolean(settings?.openrouter?.configured) },
    { endpoint: "/api/providers/polza/models?type=image", providerId: "polza", configured: Boolean(settings?.polza?.configured) },
    { endpoint: "/api/providers/polza/models?type=video", providerId: "polza", configured: Boolean(settings?.polza?.configured) },
    { endpoint: "/api/providers/polza/models?type=chat", providerId: "polza", configured: Boolean(settings?.polza?.configured) }
  ];
  const loaded: ModelOption[] = [];
  for (const source of sources) {
    if (!source.configured) continue;
    try {
      const response = await getJson(source.endpoint);
      loaded.push(...normalizeModelOptions(response, source.providerId));
    } catch (error) {
      errors[source.providerId] = error instanceof Error ? error.message : "Catalog request failed.";
    }
  }
  return { models: mergeModelOptions([...fallbackModels, ...configuredBuiltInModels(settings), ...loaded]), errors };
}

export function modelsForContentKind(models: ModelOption[], kind: ContentKind): ModelOption[] {
  return models.filter((model) => model.isAvailable && !model.role && model.produces.includes(kind));
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
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const produces = inferProducedKinds(record, providerId);
    if (produces.length === 0) return [];
    const role = inferModelRole(record, produces);
    const accepts = inferAcceptedKinds(record);
    const generationParameters = modelGenerationParameterDefinitions(record);
    return [{
      id,
      title: String(record.title ?? record.label ?? record.displayName ?? record.name ?? id),
      providerId: String(record.providerId ?? record.provider ?? providerId),
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

export function localProviderModelOptions(provider: { id: string; title: string; providerType: string; status: string; models?: Array<{ id?: string; title?: string; modelName?: string }> }): ModelOption[] {
  if (provider.status !== "connected") return [];
  return (provider.models ?? []).flatMap((model) => {
    const id = model.id ?? model.modelName ?? model.title;
    if (!id) return [];
    return [{
      id,
      title: model.title ?? model.modelName ?? id,
      providerId: provider.id,
      contentKinds: ["image"],
      accepts: ["text", "image"],
      produces: ["image"],
      capabilities: ["image.generate"],
      source: provider.providerType,
      isAvailable: false,
      statusReason: `${provider.title} is connected; canvas execution for local models is not wired yet.`
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
  if (explicitType === "video") return ["video"];
  if (explicitType === "image") return ["image"];
  if (explicitType === "chat" || explicitType === "text") return ["text"];
  if (explicitType === "audio") return ["audio"];
  const text = modelMetadataText(record);
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
  const values = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : [];
  const matched = values.flatMap((value) => contentKind(value));
  if (matched.length) return [...new Set(matched)];
  return modelAcceptsImageInput(record) ? ["text", "image"] : ["text"];
}

function inferCapabilities(record: Record<string, unknown>, produces: ContentKind[]): string[] {
  const explicit = Array.isArray(record.capabilities) ? record.capabilities.map(String) : [];
  return [...new Set([...explicit, ...produces.map((kind) => `${kind}.generate`)])];
}

function modelMetadataText(record: Record<string, unknown>): string {
  const architecture = objectValue(record.architecture);
  return [
    record.nodeTypes, record.nodeType, record.type, record.capabilities, record.modalities,
    record.inputModalities, record.outputModalities, architecture.input_modalities,
    architecture.output_modalities, architecture.modality, record.tasks, record.kind,
    record.category, record.family, record.id
  ].flatMap((field) => Array.isArray(field) ? field : [field]).filter(Boolean).map(String).join(" ").toLowerCase();
}

function contentKind(value: string): ContentKind[] {
  const normalized = value.toLowerCase();
  return normalized === "image" || normalized === "video" || normalized === "text" || normalized === "audio"
    ? [normalized]
    : [];
}

function modelAcceptsImageInput(record: Record<string, unknown>): boolean {
  const architecture = objectValue(record.architecture);
  const provider = objectValue(record.top_provider);
  const parameters = objectValue(provider.parameters);
  const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : [];
  return inputModalities.some((modality) => modality.toLowerCase() === "image") || Object.hasOwn(parameters, "images");
}

function modelMaxImageInputs(record: Record<string, unknown>): number | undefined {
  const direct = Number(record.maxImageInputs ?? record.maxImages);
  if (Number.isInteger(direct) && direct > 0) return direct;
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
  if (!Array.isArray(record.generationParameters)) return undefined;
  const definitions = record.generationParameters.flatMap((source) => {
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

function parameterValue(value: unknown): GenerationParameterValue | undefined {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
