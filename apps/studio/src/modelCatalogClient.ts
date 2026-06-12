import { apiBase } from "./studioConfig";
import type { ModelOptionForNodeV1, UnifiedModelInfo } from "./studioTypes";

type ModelsApiResponse = {
  ok?: boolean;
  models?: unknown;
};

export async function fetchImageCatalogModels(): Promise<UnifiedModelInfo[]> {
  const response = await fetch(`${apiBase}/api/models/v1`);
  const result = await response.json() as ModelsApiResponse;
  if (!response.ok || result.ok === false) throw new Error("Image model catalog unavailable.");
  return Array.isArray(result.models)
    ? result.models.flatMap(normalizeV1ImageModel)
    : [];
}

export async function fetchModelsForNode(nodeType: string): Promise<ModelOptionForNodeV1[]> {
  const response = await fetch(`${apiBase}/api/models/for-node/${encodeURIComponent(nodeType)}`);
  const result = await response.json() as ModelsApiResponse;
  if (!response.ok || result.ok === false) throw new Error(`Model catalog unavailable for ${nodeType}.`);
  return Array.isArray(result.models)
    ? result.models.filter((entry): entry is ModelOptionForNodeV1 => isModelOptionForNode(entry, nodeType))
    : [];
}

function normalizeV1ImageModel(value: unknown): UnifiedModelInfo[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (!(typeof record.id === "string"
    && typeof record.provider === "string"
    && typeof record.providerModelId === "string"
    && typeof record.displayName === "string"
    && typeof record.iconPath === "string"
    && Array.isArray(record.outputTypes)
    && record.outputTypes.includes("image")
    && Array.isArray(record.parameters))) return [];
  return [{
    id: record.id,
    provider: record.provider,
    providerModelId: record.providerModelId,
    displayName: record.displayName,
    outputType: "image",
    inputTypes: Array.isArray(record.inputTypes) ? record.inputTypes.map(String).filter(Boolean) : [],
    iconKey: typeof record.iconKey === "string" ? record.iconKey : record.provider,
    iconPath: record.iconPath,
    parameters: record.parameters as UnifiedModelInfo["parameters"],
    catalogStatus: record.catalogStatus === "known" ? "known" : "unknown",
    capabilities: Array.isArray(record.capabilities) ? record.capabilities.map(String).filter(Boolean) : undefined,
    aliases: Array.isArray(record.aliases) ? record.aliases.map(String).filter(Boolean) : undefined,
    metadata: record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : undefined
  }];
}

function isModelOptionForNode(value: unknown, nodeType: string): value is ModelOptionForNodeV1 {
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
    && Array.isArray(record.parameters)
    && record.nodeType === nodeType
    && typeof record.storedModelId === "string"
    && typeof record.executionProvider === "string";
}
