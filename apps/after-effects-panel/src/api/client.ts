import type { GenerationJob, VideoModel } from "../types";

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
  async models(): Promise<VideoModel[]> { const body = await this.request<{ models: VideoModel[] }>("/api/models/for-node/polza.video.generate"); return body.models ?? []; }
  async quote(model: VideoModel, params: Record<string, unknown>) { return this.request<{ selected?: { estimatedCost?: number | null; currency?: string | null }; warnings?: string[] }>("/api/model-gateway/quote", { method: "POST", body: JSON.stringify({ nodeType: model.nodeType, params: { ...params, model: model.storedModelId } }) }); }
  async importAsset(filename: string, dataBase64: string) { return this.request<{ path: string }>("/api/assets/import", { method: "POST", body: JSON.stringify({ filename, dataBase64, kind: "image" }) }); }
  async createJob(input: { model: VideoModel; prompt: string; parameters: Record<string, unknown>; assetPath?: string }) { const body = await this.request<{ job: GenerationJob }>("/api/model-gateway/jobs", { method: "POST", body: JSON.stringify({ capability: "video.generate", nodeType: input.model.nodeType, modelId: input.model.storedModelId, provider: input.model.provider, prompt: input.prompt, parameters: input.parameters, inputs: input.assetPath ? [{ kind: "image", path: input.assetPath }] : [] }) }); return body.job; }
  async job(id: string) { const body = await this.request<{ job: GenerationJob }>(`/api/model-gateway/jobs/${encodeURIComponent(id)}`); return body.job; }
  async download(path: string): Promise<ArrayBuffer> { const response = await this.fetchImpl(this.url(path)); if (!response.ok) throw await responseError(response); return response.arrayBuffer(); }

  private url(path: string) { return `${this.baseUrl.replace(/\/$/, "")}${path}`; }
  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> { const response = await this.fetchImpl(this.url(path), { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } }); if (!response.ok) throw await responseError(response); return response.json() as Promise<T>; }
}

async function responseError(response: Response): Promise<GatewayError> { let message = `${response.status} ${response.statusText}`; try { const body = await response.json() as { error?: string }; if (body.error) message = body.error; } catch {} return new GatewayError(message, response.status); }
