import { readFile } from "node:fs/promises";
import { type NodeRunner } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import {
  createModelResolver,
  createOpenRouterImageNodeRunner,
  createOpenRouterTextNodeRunner,
  readOpenRouterModelCatalogCache,
  resolutionMetadata,
  type ModelMapping,
  type OpenRouterModelInfo,
  type ProviderMode
} from "@snarkroute/openrouter";
import { openRouterCatalogCachePath, openRouterMappingsPath } from "../server-paths";
import { errorMessage } from "../services/errors";
import { isGeminiEnabled, isOpenRouterEnabled } from "../services/env";
export async function openRouterSettingsStatus() {
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  const defaultModel = process.env.OPENROUTER_DEFAULT_MODEL?.trim() || "text.default";
  const models = cache?.models ?? [];
  const resolvedDefault = defaultModel === "text.default" ? "openai/gpt-5.2" : defaultModel;
  return {
    configured: isOpenRouterEnabled(),
    maskedApiKey: isOpenRouterEnabled() ? maskSecret(process.env.OPENROUTER_API_KEY) : "",
    defaultModel,
    budgetWarningUsd: numberEnv("OPENROUTER_BUDGET_WARNING_USD"),
    catalog: {
      refreshedAt: cache?.refreshedAt ?? null,
      modelCount: models.length
    },
    defaultModelStatus: models.length === 0 ? "catalog-empty" : models.some((model) => model.id === resolvedDefault) ? "available" : "not-in-catalog"
  };
}

export async function loadOpenRouterMappings(): Promise<ModelMapping[]> {
  const parsed = JSON.parse(await readFile(openRouterMappingsPath, "utf8")) as { models?: unknown };
  return Array.isArray(parsed.models) ? parsed.models.filter((entry): entry is ModelMapping => Boolean(entry && typeof entry === "object" && typeof (entry as ModelMapping).id === "string")) : [];
}

export function createRemoteTextNodeRunner(modelResolver: ReturnType<typeof createModelResolver>): NodeRunner {
  const openRouterRunner = createOpenRouterTextNodeRunner({ modelResolver });
  const rawOpenRouterRunner = createOpenRouterTextNodeRunner();
  const geminiRunner = createGeminiLlmNodeRunner();
  return async (input) => {
    const providerMode = providerModeParam(input.params.providerMode);
    const requestedModel = stringValue(input.params.model);
    const modelId = !requestedModel || requestedModel === "text.default" ? process.env.OPENROUTER_DEFAULT_MODEL || "text.default" : requestedModel;
    if (modelId.includes("/") && providerMode !== "direct") return rawOpenRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    const resolution = modelResolver({ task: "text", modelId, providerMode });
    if (resolution.provider === "openrouter") return openRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
      return geminiRunner({ ...input, params: { ...input.params, model: resolution.model } });
    }
    throw new Error(resolution.provider === "direct" ? "Direct provider is not configured." : "Local provider is not available.");
  };
}

export function createRemoteImageNodeRunner(modelResolver: ReturnType<typeof createModelResolver>): NodeRunner {
  const geminiRunner = createNanoBanana2NodeRunner();
  const openRouterRunner = createOpenRouterImageNodeRunner({ modelResolver });
  return async (input) => {
    const providerMode = providerModeParam(input.params.providerMode);
    const modelId = stringValue(input.params.model) || "image.nano-banana";
    const cachedCatalog = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
    const cachedModel = cachedCatalog?.models.find((model) => model.id === modelId);
    if (cachedModel && !openRouterModelSupportsImage(cachedModel)) throw new Error("This model is not available for image generation.");
    if (cachedModel && openRouterModelSupportsImage(cachedModel) && providerMode !== "direct") {
      if (!isOpenRouterEnabled()) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
      const catalogBackedRunner = createOpenRouterImageNodeRunner({
        modelResolver: createModelResolver([catalogImageModelMapping(cachedModel)])
      });
      return catalogBackedRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    }
    const resolution = modelResolver({ task: "image", modelId, providerMode });
    if (resolution.provider === "openrouter") {
      if (!isOpenRouterEnabled()) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
      return openRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    }
    if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
      if (!isGeminiEnabled()) throw new Error("Direct API is selected, but direct provider credentials are missing.");
      const result = await geminiRunner({ ...input, params: { ...input.params, model: resolution.model } });
      const metadata = resolutionMetadata(resolution, {
        requestProvider: resolution.directProvider,
        requestModelSlug: resolution.model,
        estimatedCostStatus: "unknown"
      });
      return {
        ...result,
        output: result.output && typeof result.output === "object" ? { ...(result.output as Record<string, unknown>), metadata, ...metadata } : result.output,
        logs: [...(result.logs ?? []), `Resolved route: ${metadata.resolvedRoute}; fallback: ${metadata.fallbackUsed ? metadata.fallbackReason || "yes" : "no"}`],
        provenance: { ...(result.provenance ?? {}), ...metadata }
      };
    }
    throw new Error(resolution.provider === "direct" ? `Direct API route requires a provider mapping for ${modelId}, but none was found.` : "Local provider is not available.");
  };
}

function catalogImageModelMapping(model: OpenRouterModelInfo): ModelMapping {
  return {
    id: model.id,
    task: "image",
    label: model.name ? `${model.name} (${model.id})` : model.id,
    provider: model.id.split("/")[0] || "openrouter",
    capabilities: ["image-generation"],
    supportsImageGeneration: "supported",
    openrouterModel: model.id,
    directProvider: null,
    directModel: null,
    status: "supported",
    routeSupport: { openrouter: "supported", direct: "unknown" }
  };
}

function openRouterModelSupportsImage(model: OpenRouterModelInfo): boolean {
  if (isOpenRouterRoutingAlias(model.id)) return false;
  const output = model.architecture?.output_modalities ?? [];
  const modality = model.architecture?.modality ?? "";
  return output.includes("image") || modalityOutputModalities(modality).includes("image");
}

function isOpenRouterRoutingAlias(modelId: string): boolean {
  return modelId === "openrouter/auto";
}

function modalityOutputModalities(modality: string): string[] {
  if (!modality) return [];
  const outputSide = modality.includes("->") ? modality.split("->").pop() ?? "" : modality;
  return outputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function providerModeParam(value: unknown): ProviderMode {
  return value === "openrouter" || value === "direct" || value === "local" ? value : "auto";
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export function numberEnv(key: string): number | null {
  const number = Number(process.env[key]);
  return Number.isFinite(number) ? number : null;
}

export function maskSecret(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.length <= 8 ? "********" : `${trimmed.slice(0, 4)}${"*".repeat(Math.min(16, Math.max(8, trimmed.length - 8)))}${trimmed.slice(-4)}`;
}

export function openRouterPublicError(error: unknown): string {
  const message = errorMessage(error);
  if (/missing|not set/i.test(message)) return "OpenRouter API key is not set";
  if (/invalid|401|403/i.test(message)) return "OpenRouter API key seems invalid.";
  if (/not available/i.test(message)) return "Model is not available through OpenRouter.";
  if (/unreachable|fetch failed|network request failed/i.test(message)) return "OpenRouter is unreachable. The API key is configured, but SnarkRoute cannot reach OpenRouter. Check internet access, proxy/VPN/firewall settings, DNS, or OPENROUTER_BASE_URL.";
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}
