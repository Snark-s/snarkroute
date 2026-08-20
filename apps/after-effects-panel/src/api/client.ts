import { capabilityForOperation, outputMediaTypeForOperation } from "./catalog";
import type { GenerationInput, GenerationJob, GenerationModel, GenerationOperation, ImportedAsset } from "../types";
import type { H3RegenerationJob, H3RegenerationQuote, PortableToolJob, PublishedTool } from "../tools/schema";

export class GatewayError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export type ConnectionProbeResult = {
  connected: boolean;
  url: string;
  attemptedAt: string;
  status: number | null;
  responseBody: string;
  error: string | null;
};

export class SnarkRouteGatewayClient {
  private readonly fetchImpl: typeof fetch;

  constructor(readonly baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  async health(): Promise<ConnectionProbeResult> {
    const url = this.url("/health");
    const attemptedAt = new Date().toISOString();
    const runtimeOrigin = typeof window === "undefined" ? "non-browser" : window.location.origin;
    console.info("[SnarkRoute] connection probe start", { url, attemptedAt, runtimeOrigin });
    try {
      const response = await this.fetchImpl(url, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } });
      const responseBody = await response.text();
      const result: ConnectionProbeResult = {
        connected: response.ok,
        url,
        attemptedAt,
        status: response.status,
        responseBody,
        error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`.trim()
      };
      console.info("[SnarkRoute] connection probe end", result);
      if (!response.ok) console.error("[SnarkRoute] connection probe HTTP error", result);
      return result;
    } catch (error) {
      const exactError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const result: ConnectionProbeResult = { connected: false, url, attemptedAt, status: null, responseBody: "", error: exactError };
      console.error("[SnarkRoute] connection probe end", result, error);
      return result;
    }
  }
  async models(): Promise<{ models: GenerationModel[]; modelCount: number; familyCount: number; diagnosticsUrl: string }> { const body = await this.request<{ models?: GenerationModel[]; modelCount?: number }>("/api/models/executable-generation?materialize=image,audio,video&multipleImages=1", { cache: "no-store" }); const models = body.models ?? []; return { models, modelCount: body.modelCount ?? models.length, familyCount: new Set(models.map((model) => model.originVendor || model.provider)).size, diagnosticsUrl: "/api/models/executable-generation?materialize=image,audio,video&multipleImages=1" }; }
  async quote(model: GenerationModel, params: Record<string, unknown>) { return this.request<{ selected?: { estimatedCost?: number | null; currency?: string | null }; warnings?: string[] }>("/api/model-gateway/quote", { method: "POST", body: JSON.stringify({ nodeType: model.nodeType, params: { ...params, model: model.storedModelId } }) }); }
  async importAsset(filename: string, dataBase64: string, kind: "image" | "audio" | "video" = "image") { return this.request<ImportedAsset>("/api/assets/import", { method: "POST", body: JSON.stringify({ filename, dataBase64, kind }) }); }
  async createJob(input: { model: GenerationModel; operation?: GenerationOperation; prompt: string; parameters: Record<string, unknown>; assets?: Array<ImportedAsset & { input: Omit<GenerationInput, "assetId" | "localPath"> }>; asset?: ImportedAsset }) {
    const request = providerNeutralJobRequest(input);
    console.info("[SnarkRoute] provider-neutral generation request", redactSecrets({
      modelId: input.model.storedModelId,
      providerModelId: input.model.providerModelId,
      inputCount: input.assets?.length ?? (input.asset ? 1 : 0),
      request
    }));
    const body = await this.request<{ job: GenerationJob }>("/api/model-gateway/jobs", { method: "POST", body: JSON.stringify(request) });
    return body.job;
  }
  async job(id: string) { const body = await this.request<{ job: GenerationJob }>(`/api/model-gateway/jobs/${encodeURIComponent(id)}`); return body.job; }
  async cancelJob(id: string) { const body = await this.request<{ job: GenerationJob }>(`/api/model-gateway/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }); return body.job; }
  async retryJob(id: string, idempotencyKey: string) { const body = await this.request<{ job: GenerationJob }>(`/api/model-gateway/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ idempotencyKey }) }); return body.job; }
  async selectJobResult(id: string, index: number) { const body = await this.request<{ job: GenerationJob }>(`/api/model-gateway/jobs/${encodeURIComponent(id)}/select-result`, { method: "POST", body: JSON.stringify({ index }) }); return body.job; }
  async tools() { const body = await this.request<{ tools?: PublishedTool[]; diagnostics?: unknown[] }>("/api/tools?host=after_effects", { cache: "no-store" }); return { tools: body.tools ?? [], diagnostics: body.diagnostics ?? [] }; }
  async createToolJob(toolId: string, request: { schemaVersion: string; hostType: "after_effects"; inputs: Record<string, unknown>; parameters: Record<string, unknown>; sourceContext?: Record<string, unknown>; correlationId?: string; idempotencyKey: string }) { const body = await this.request<{ job: PortableToolJob }>(`/api/tools/${encodeURIComponent(toolId)}/jobs`, { method: "POST", body: JSON.stringify(request) }); return body.job; }
  async toolJob(id: string) { const body = await this.request<{ job: PortableToolJob }>(`/api/tool-jobs/${encodeURIComponent(id)}`); return body.job; }
  async cancelToolJob(id: string) { const body = await this.request<{ job: PortableToolJob }>(`/api/tool-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }); return body.job; }
  async selectToolResult(id: string, resultId: string) { const body = await this.request<{ job: PortableToolJob }>(`/api/tool-jobs/${encodeURIComponent(id)}/select-result`, { method: "POST", body: JSON.stringify({ resultId }) }); return body.job; }
  async h3RegenerationAvailability(duration: number) { return this.request<{ available: boolean; reason?: string; quote: H3RegenerationQuote }>(`/api/h3-regeneration/availability?duration=${encodeURIComponent(String(duration))}`); }
  async regenerateH3In2K(toolJobId: string, resultId: string, idempotencyKey: string) { const body = await this.request<{ job: H3RegenerationJob }>(`/api/tool-jobs/${encodeURIComponent(toolJobId)}/regenerate-2k`, { method: "POST", body: JSON.stringify({ resultId, idempotencyKey }) }); return body.job; }
  async h3RegenerationJob(id: string) { const body = await this.request<{ job: H3RegenerationJob }>(`/api/h3-regeneration-jobs/${encodeURIComponent(id)}`); return body.job; }
  async cancelH3Regeneration(id: string) { const body = await this.request<{ job: H3RegenerationJob }>(`/api/h3-regeneration-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }); return body.job; }
  async download(path: string): Promise<ArrayBuffer> { const response = await this.fetchImpl(this.url(path)); if (!response.ok) throw await responseError(response); return response.arrayBuffer(); }

  private url(path: string) { return /^https?:\/\//i.test(path) ? path : `${this.baseUrl.replace(/\/$/, "")}${path}`; }
  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> { const response = await this.fetchImpl(this.url(path), { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } }); if (!response.ok) throw await responseError(response); return response.json() as Promise<T>; }
}

export function providerNeutralJobRequest(input: { model: GenerationModel; operation?: GenerationOperation; prompt: string; parameters: Record<string, unknown>; assets?: Array<ImportedAsset & { input: Omit<GenerationInput, "assetId" | "localPath"> }>; asset?: ImportedAsset }) {
  const operation = input.operation ?? "image-to-video";
  const assets = input.assets ?? (input.asset ? [{ ...input.asset, input: { kind: "image" as const, role: "source", index: 0, sourceType: "current-composition-frame" as const } }] : []);
  return { capability: capabilityForOperation(operation), outputMediaType: outputMediaTypeForOperation(operation), nodeType: input.model.nodeType, modelId: input.model.storedModelId, providerModelId: input.model.providerModelId, provider: input.model.provider, ...(input.prompt.trim() ? { prompt: input.prompt.trim() } : {}), parameters: input.parameters, inputs: assets.map((asset) => ({ kind: asset.input.kind, role: asset.input.role, index: asset.input.index, assetId: asset.id, path: asset.path })) };
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, /api[_-]?key|token|secret|password/i.test(key) ? "[redacted]" : redactSecrets(nested)]));
}

async function responseError(response: Response): Promise<GatewayError> { let message = `${response.status} ${response.statusText}`; try { const body = await response.json() as { error?: string }; if (body.error) message = body.error; } catch {} return new GatewayError(message, response.status); }
