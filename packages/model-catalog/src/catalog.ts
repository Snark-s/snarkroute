import type {
  ModelCatalogEntry,
  ModelInputType,
  ModelOutputType,
  ModelParameterDefinition,
  ModelProviderId,
  ProviderModelLike,
  UnifiedModelInfo
} from "./types.js";

const allowedOutputTypes = new Set<ModelOutputType>(["text", "image", "video", "audio", "embedding", "json", "unknown"]);
const allowedInputTypes = new Set<ModelInputType>(["text", "image", "video", "audio", "file", "json"]);
const iconBasePath = "/api/model-icons";

const knownModels = defineModelCatalog([
  {
    provider: "gemini",
    providerModelId: "gemini-3.1-flash-image-preview",
    displayName: "Nano Banana Image",
    outputType: "image",
    inputTypes: ["text", "image"],
    iconKey: "nano-banana",
    aliases: ["image.nano-banana", "gemini.nano-banana-2"],
    capabilities: ["image.generate", "image.reference"],
    maxImageInputs: 14,
    parameters: [
      selectParameter("aspectRatio", "Aspect ratio", ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"], "1:1"),
      selectParameter("imageSize", "Resolution", ["1K", "2K", "4K"], "2K")
    ]
  },
  {
    provider: "gemini",
    providerModelId: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash-Lite",
    outputType: "text",
    inputTypes: ["text", "image"],
    iconKey: "gemini",
    aliases: ["text.gemini-lite"],
    capabilities: ["text.generate"]
  },
  {
    provider: "openrouter",
    providerModelId: "openai/gpt-5.2",
    displayName: "GPT-5.2 via OpenRouter",
    outputType: "text",
    inputTypes: ["text", "image"],
    iconKey: "gpt",
    aliases: ["text.default"],
    capabilities: ["text.generate", "json.generate"]
  },
  {
    provider: "polza",
    providerModelId: "openai/gpt-5.4-image-2",
    displayName: "GPT-5.4 Image 2",
    outputType: "image",
    inputTypes: ["text", "image"],
    iconKey: "gpt",
    capabilities: ["image.generate"],
    maxImageInputs: 14,
    parameters: [
      selectParameter("aspectRatio", "Aspect ratio", ["auto", "1:1", "5:4", "4:5", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"], "auto"),
      numberParameter("n", "Images", 1, 1, 4, 1)
    ]
  },
  {
    provider: "polza",
    providerModelId: "wan/2.6",
    displayName: "Wan 2.6",
    outputType: "video",
    inputTypes: ["text", "image"],
    iconKey: "wan",
    capabilities: ["video.generate"],
    maxImageInputs: 2,
    parameters: [
      selectParameter("resolution", "Resolution", ["720p", "1080p"], "720p"),
      selectParameter("duration", "Duration", ["5", "10", "15"], "5")
    ]
  },
  {
    provider: "replicate",
    providerModelId: "philz1337x/clarity-upscaler",
    displayName: "Clarity Upscaler",
    outputType: "image",
    inputTypes: ["image"],
    iconKey: "replicate",
    capabilities: ["image.upscale"],
    maxImageInputs: 1
  }
]);

export function listKnownModels(): UnifiedModelInfo[] {
  return knownModels.map(toUnifiedKnownModel);
}

export function getKnownModel(provider: ModelProviderId, providerModelId: string): UnifiedModelInfo | undefined {
  const providerKey = normalizeKey(provider);
  const modelKey = normalizeKey(providerModelId);
  return listKnownModels().find((model) =>
    normalizeKey(model.provider) === providerKey
    && (normalizeKey(model.providerModelId) === modelKey || (model.aliases ?? []).some((alias) => normalizeKey(alias) === modelKey))
  );
}

export function normalizeProviderModel(provider: ModelProviderId, providerModel: ProviderModelLike): UnifiedModelInfo {
  const providerModelId = stringField(providerModel, "id")
    ?? stringField(providerModel, "providerModelId")
    ?? stringField(providerModel, "modelId")
    ?? stringField(providerModel, "slug")
    ?? stringField(providerModel, "name")
    ?? "";
  if (!providerModelId) throw new Error("Provider model is missing an id.");

  const known = getKnownModel(provider, providerModelId);
  if (known) return known;

  const iconKey = iconKeyForProvider(provider);
  return {
    id: `${provider}:${providerModelId}`,
    provider,
    providerModelId,
    displayName: stringField(providerModel, "displayName") ?? stringField(providerModel, "title") ?? stringField(providerModel, "label") ?? stringField(providerModel, "name") ?? providerModelId,
    outputType: "unknown",
    inputTypes: [],
    parameters: [],
    iconKey,
    iconPath: iconPathForKey(iconKey),
    aliases: [],
    capabilities: [],
    metadata: {
      providerRawHints: {
        capabilities: stringArray(providerModel.capabilities),
        generationParameters: providerModel.generationParameters ?? objectField(providerModel, "metadata").generationParameters,
        inputTypes: providerModel.inputTypes,
        outputTypes: providerModel.outputTypes,
        architecture: providerModel.architecture,
        maxImageInputs: providerModel.maxImageInputs
      }
    },
    catalogStatus: "unknown"
  };
}

export function iconPathForKey(iconKey: string): string {
  const key = iconKey.trim();
  if (!key) throw new Error("Model icon key must be non-empty.");
  return `${iconBasePath}/${encodeURIComponent(iconFilenameForKey(key))}`;
}

export function defineModelCatalog(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    validateCatalogEntry(entry);
    const key = catalogKey(entry.provider, entry.providerModelId);
    if (seen.has(key)) throw new Error(`Duplicate model catalog entry: ${entry.provider}:${entry.providerModelId}`);
    seen.add(key);
    return { ...entry, iconPath: entry.iconPath ?? iconPathForKey(entry.iconKey) };
  });
}

function toUnifiedKnownModel(entry: ModelCatalogEntry): UnifiedModelInfo {
  return {
    ...entry,
    id: `${entry.provider}:${entry.providerModelId}`,
    inputTypes: entry.inputTypes ?? ["text"],
    parameters: entry.parameters ?? [],
    iconPath: entry.iconPath ?? iconPathForKey(entry.iconKey),
    catalogStatus: "known"
  };
}

function validateCatalogEntry(entry: ModelCatalogEntry): void {
  if (!entry.provider) throw new Error("Model catalog entry is missing provider.");
  if (!entry.providerModelId) throw new Error("Model catalog entry is missing providerModelId.");
  if (!entry.displayName) throw new Error("Model catalog entry is missing displayName.");
  if (!allowedOutputTypes.has(entry.outputType)) throw new Error(`Invalid model output type: ${entry.outputType}`);
  if (!entry.iconKey?.trim()) throw new Error("Model catalog entry is missing iconKey.");
  for (const inputType of entry.inputTypes ?? []) {
    if (!allowedInputTypes.has(inputType)) throw new Error(`Invalid model input type: ${inputType}`);
  }
  for (const parameter of entry.parameters ?? []) validateParameter(parameter);
}

function validateParameter(parameter: ModelParameterDefinition): void {
  if (!parameter.id) throw new Error("Model parameter is missing id.");
  if (!parameter.type) throw new Error(`Model parameter "${parameter.id}" is missing type.`);
  if (parameter.type === "select") {
    if (!parameter.options?.length) throw new Error(`Select parameter "${parameter.id}" must define options.`);
    if (parameter.default !== undefined && !parameter.options.some((option) => option.value === parameter.default)) {
      throw new Error(`Select parameter "${parameter.id}" default must match one of its options.`);
    }
  }
  if (parameter.type !== "select" && parameter.options?.length) {
    throw new Error(`Non-select parameter "${parameter.id}" must not define options.`);
  }
}

function iconKeyForProvider(provider: ModelProviderId): string {
  const providerKey = normalizeKey(provider);
  const icons: Record<string, string> = {
    anthropic: "claude",
    gemini: "gemini",
    openai: "gpt",
    openrouter: "openrouter",
    polza: "polza",
    replicate: "replicate"
  };
  return icons[providerKey] ?? "unknown";
}

function iconFilenameForKey(iconKey: string): string {
  const filenames: Record<string, string> = {
    claude: "claude.png",
    gemini: "gemini.png",
    gpt: "gpt.png",
    "nano-banana": "nano-banana.svg",
    openrouter: "openrouter.svg",
    polza: "polza.svg",
    replicate: "replicate.svg",
    unknown: "unknown.svg",
    wan: "wan.svg"
  };
  return filenames[iconKey] ?? `${iconKey}.svg`;
}

function selectParameter(id: string, label: string, options: string[], defaultValue: string): ModelParameterDefinition {
  return { id, label, type: "select", default: defaultValue, options: options.map((value) => ({ value })) };
}

function numberParameter(id: string, label: string, defaultValue: number, min: number, max: number, step: number): ModelParameterDefinition {
  return { id, label, type: "number", default: defaultValue, min, max, step };
}

function catalogKey(provider: ModelProviderId, providerModelId: string): string {
  return `${normalizeKey(provider)}:${normalizeKey(providerModelId)}`;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function objectField(value: unknown, key?: string): ProviderModelLike {
  const candidate = key === undefined ? value : value && typeof value === "object" ? (value as ProviderModelLike)[key] : undefined;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as ProviderModelLike : {};
}

function stringField(record: ProviderModelLike, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: ProviderModelLike, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
