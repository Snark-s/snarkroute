import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelCatalogEntryV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { modelCostTier } from "./model-routing-policy";

/**
 * Which SnarkRoute models other networks (Codex, Claude, ChatGPT through MCP) may use.
 * Owner state lives on disk; SnarkRoute's own UI and routes keep the full catalog.
 */
export type ModelExposurePolicy = {
  version: 1;
  /** Only local (zero-cost, on this computer) providers are exposed. */
  localOnly: boolean;
  /** Only the providers and models listed below are exposed. */
  selectedOnly: boolean;
  providers: string[];
  /** Catalog ids, `provider:providerModelId`. */
  models: string[];
  updatedAt?: string;
};

export type ModelExposureType = "text" | "image" | "video" | "audio" | "model" | "upscale" | "embedding" | "other";
export type ExposedModelEntry = { id: string; provider: string; providerModelId: string; displayName: string; type: ModelExposureType; local: boolean; available: boolean; exposed: boolean; reason?: string };
export type ModelExposureProviderGroup = { provider: string; local: boolean; selected: boolean; models: ExposedModelEntry[] };
export type ModelExposureTypeGroup = { type: ModelExposureType; label: string; modelCount: number; exposedCount: number; providers: ModelExposureProviderGroup[] };

export const modelExposurePolicyPath = () => process.env.SNARKROUTE_MODEL_EXPOSURE_PATH ?? join(process.cwd(), "data", "model-exposure.json");
export const defaultModelExposurePolicy = (): ModelExposurePolicy => ({ version: 1, localOnly: false, selectedOnly: false, providers: [], models: [] });

const TYPE_LABELS: Record<ModelExposureType, string> = {
  text: "Текст", image: "Изображения", video: "Видео", audio: "Аудио", model: "3D", upscale: "Апскейл", embedding: "Эмбеддинги", other: "Прочее"
};
const TYPE_ORDER: ModelExposureType[] = ["text", "image", "video", "audio", "model", "upscale", "embedding", "other"];
// Workers that run on this computer. Hosted H3 shares the minimax-h3 provider, so H3 goes through modelCostTier.
const LOCAL_PROVIDERS = new Set(["local", "local_openai", "local_upscale", "local_video_upscale", "flux3_native", "qwen_edit_local"]);

export function isLocalModelProvider(provider: string, providerModelId = "", metadata: Record<string, unknown> = {}): boolean {
  return LOCAL_PROVIDERS.has(provider) || modelCostTier(provider, providerModelId, metadata, undefined, []) === "local";
}

export function normalizeModelExposurePolicy(value: unknown): ModelExposurePolicy {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const ids = (list: unknown, limit: number) => Array.isArray(list)
    ? [...new Set(list.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(item => item && item.length <= 300))].slice(0, limit)
    : [];
  return {
    version: 1,
    localOnly: record.localOnly === true,
    selectedOnly: record.selectedOnly === true,
    providers: ids(record.providers, 200),
    models: ids(record.models, 5000),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {})
  };
}

export async function readModelExposurePolicy(path = modelExposurePolicyPath()): Promise<ModelExposurePolicy> {
  try { return normalizeModelExposurePolicy(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultModelExposurePolicy();
    throw error;
  }
}

export async function writeModelExposurePolicy(value: unknown, path = modelExposurePolicyPath()): Promise<ModelExposurePolicy> {
  const policy = { ...normalizeModelExposurePolicy(value), updatedAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return policy;
}

/** Why a model is hidden from other networks, or undefined when it is exposed. */
export function modelExposureBlock(policy: ModelExposurePolicy, model: { provider: string; providerModelId: string; id?: string; metadata?: Record<string, unknown> }): string | undefined {
  if (policy.localOnly && !isLocalModelProvider(model.provider, model.providerModelId, model.metadata)) return "Отдаются только локальные модели.";
  const id = model.id ?? `${model.provider}:${model.providerModelId}`;
  if (policy.selectedOnly && !policy.providers.includes(model.provider) && !policy.models.includes(id)
      && !policy.models.includes(`${model.provider}:${model.providerModelId}`)) return "Модель не выбрана для внешних сетей.";
  return undefined;
}

export function modelExposureType(entry: Pick<ModelCatalogEntryV1, "outputTypes" | "roles">): ModelExposureType {
  if (entry.roles.includes("upscaler") && !entry.roles.includes("generator")) return "upscale";
  for (const type of ["video", "image", "audio", "model", "text", "embedding"] as const) {
    if (entry.outputTypes.includes(type)) return type;
  }
  return entry.outputTypes.includes("json") ? "text" : "other";
}

export function modelExposureEntries(catalog: ModelCatalogEntryV1[], policy: ModelExposurePolicy): ExposedModelEntry[] {
  return catalog.map(entry => {
    const reason = modelExposureBlock(policy, entry);
    return {
      id: entry.id, provider: entry.provider, providerModelId: entry.providerModelId, displayName: entry.displayName,
      type: modelExposureType(entry), local: isLocalModelProvider(entry.provider, entry.providerModelId, entry.metadata),
      available: entry.availability.status === "available" && entry.availability.configured !== false,
      exposed: !reason, ...(reason ? { reason } : {})
    };
  });
}

export function groupModelExposure(entries: ExposedModelEntry[], policy: ModelExposurePolicy): ModelExposureTypeGroup[] {
  return TYPE_ORDER.map(type => {
    const models = entries.filter(entry => entry.type === type);
    const providers = [...new Set(models.map(model => model.provider))].map(provider => ({
      provider,
      local: models.some(model => model.provider === provider && model.local),
      selected: policy.providers.includes(provider),
      models: models.filter(model => model.provider === provider).sort((a, b) => Number(b.available) - Number(a.available) || a.displayName.localeCompare(b.displayName))
    })).sort((a, b) => Number(b.local) - Number(a.local) || a.provider.localeCompare(b.provider));
    return { type, label: TYPE_LABELS[type], modelCount: models.length, exposedCount: models.filter(model => model.exposed).length, providers };
  }).filter(group => group.modelCount > 0);
}

export function modelExposureSummary(entries: ExposedModelEntry[]) {
  const exposed = entries.filter(entry => entry.exposed);
  return {
    models: entries.length,
    providers: new Set(entries.map(entry => entry.provider)).size,
    localModels: entries.filter(entry => entry.local).length,
    exposedModels: exposed.length,
    exposedAvailableModels: exposed.filter(entry => entry.available).length,
    exposedProviders: new Set(exposed.map(entry => entry.provider)).size
  };
}

/** Requests that other networks send through SnarkRoute's MCP server. */
export function isExternalNetworkRequest(request: { sourceContext?: Record<string, unknown> }): boolean {
  return request.sourceContext?.client === "mcp";
}

export async function assertExternalModelExposure(
  request: { provider: string; providerModelId: string; modelId?: string; sourceContext?: Record<string, unknown> },
  read: () => Promise<ModelExposurePolicy> = () => readModelExposurePolicy()
): Promise<void> {
  if (!isExternalNetworkRequest(request)) return;
  const reason = modelExposureBlock(await read(), { provider: request.provider, providerModelId: request.providerModelId, id: request.modelId });
  if (reason) throw new Error(`${request.provider}/${request.providerModelId} недоступна внешним сетям: ${reason} Владелец меняет это в Мастерской → Система → Модели и провайдеры.`);
}
