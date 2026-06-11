import { apiBase } from "./studioConfig";
import type { UnifiedModelInfo } from "./studioTypes";

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
