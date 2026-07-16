import type { GenerationJob, VideoModel } from "../types";

export class GatewayError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export class SnarkRouteGatewayClient {
  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async health(): Promise<void> { await this.request("/api/capabilities"); }
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
