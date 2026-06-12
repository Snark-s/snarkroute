import { apiBase } from "./studioConfig";
import type { ModelOptionForNodeV1, UnifiedModelInfo } from "./studioTypes";

type ModelsApiResponse = {
  ok?: boolean;
  models?: unknown;
};

export async function fetchImageCatalogModels(): Promise<UnifiedModelInfo[]> {
  const response = await fetch(`${apiBase}/api/models?outputType=image`);
  const result = await response.json() as ModelsApiResponse;
  if (!response.ok || result.ok === false) throw new Error("Image model catalog unavailable.");
  return Array.isArray(result.models)
    ? result.models.filter(isUnifiedImageModel)
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

function isUnifiedImageModel(value: unknown): value is UnifiedModelInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.provider === "string"
    && typeof record.providerModelId === "string"
    && typeof record.displayName === "string"
    && record.outputType === "image"
    && typeof record.iconPath === "string"
    && Array.isArray(record.parameters);
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
