import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelInfo, ModelInvokeRequest, ProviderAdapter } from "@snarkroute/core";
import type { NodeRunner } from "@snarkroute/executor";

export type H3Reference = { kind: "image" | "video" | "audio"; uri: string; role?: "firstFrame" | "lastFrame" | "reference"; startTimeSeconds?: number; requireVideoAudio?: boolean };
export type H3GenerationInput = { prompt: string; duration: number; aspectRatio?: string; seed?: number; references?: H3Reference[]; variants?: number; quality?: "lossless" | "high"; renderMode?: "preview" | "final"; turboLora?: boolean; inferenceSteps?: number };
export type H3WorkerRequest = { operation: "video.generate.h3"; task: "t2va" | "fl2va" | "ref2va"; prompt: string; conditions: Array<Record<string, unknown>>; target: { short_edge: 768; aspect_ratio: string; duration_seconds: number }; seed?: number; num_outputs_per_prompt: number; num_inference_steps: number; quality_mode: "preview" | "final"; quality: "lossless" | "high"; turbo_lora: boolean };
export type H3WorkerError = { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
export type H3WorkerJob = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "completed"; stage?: string; progress?: number; error?: H3WorkerError | string; outputs?: Array<{ index: number; filename: string; mime_type: string; bytes: number; storage_backend: string; storage_key: string }>; metadata?: Record<string, unknown>; variants?: number };
export type H3WorkerAsset = { id: string; uri: string; mimeType: string };
export type H3RegenerationTask = { task_id?: string; task?: { id?: string; status?: string; content?: { url?: string } }; status?: string };
export type H3RegenerationQuote = { durationSeconds: number; rateUsdPerSecond: number; providerUsd: number; baseCredits: number; markupCredits: number; finalCredits: number; currency: "USD"; source: string; effectiveDate: string };

export function serializeH3Request(input: H3GenerationInput): H3WorkerRequest {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error("MiniMax H3 requires a prompt.");
  if (!Number.isFinite(input.duration) || input.duration < 4 || input.duration > 15) throw new Error("MiniMax H3 duration must be between 4 and 15 seconds.");
  const references = input.references ?? [], first = references.filter((item) => item.role === "firstFrame"), last = references.filter((item) => item.role === "lastFrame"), semantic = references.filter((item) => !item.role || item.role === "reference");
  if (first.length > 1 || last.length > 1) throw new Error("MiniMax H3 accepts at most one first frame and one last frame.");
  if (semantic.length && (first.length || last.length)) throw new Error("H3 keyframes and semantic references use different checkpoints and cannot be mixed in one request.");
  validateReferences(semantic);
  const task = semantic.length ? "ref2va" : first.length || last.length ? "fl2va" : "t2va";
  const conditions = task === "fl2va"
    ? [...first.map((item) => ({ type: "image", uri: safeUri(item.uri), role: "keyframe", frame_index: 0 })), ...last.map((item) => ({ type: "image", uri: safeUri(item.uri), role: "keyframe", frame_index: -1 }))]
    : semantic.map((item) => ({ type: item.kind === "video" && item.requireVideoAudio ? "video_audio" : item.kind, uri: safeUri(item.uri), role: "reference", ...(item.kind === "video" && item.startTimeSeconds !== undefined ? { start_time_seconds: nonNegative(item.startTimeSeconds) } : {}) }));
  const renderMode = input.renderMode ?? "final";
  const inferenceSteps = integerRange(input.inferenceSteps ?? (renderMode === "preview" ? 8 : 30), renderMode === "preview" ? 4 : 20, renderMode === "preview" ? 10 : 40, "inferenceSteps");
  const variants = integerRange(input.variants ?? 1, 1, 10, "variants");
  return { operation: "video.generate.h3", task, prompt, conditions, target: { short_edge: 768, aspect_ratio: input.aspectRatio?.trim() || "auto", duration_seconds: input.duration }, ...(input.seed === undefined ? {} : { seed: integerRange(input.seed, 0, 2_147_483_647, "seed") }), num_outputs_per_prompt: variants, num_inference_steps: inferenceSteps, quality_mode: renderMode, quality: input.quality ?? "lossless", turbo_lora: input.turboLora ?? false };
}

export function createH3WorkerClient(options: { baseUrl?: string; serviceToken?: string; fetchImpl?: typeof fetch; pollingIntervalMs?: number; timeoutMs?: number } = {}) {
  const baseUrl = (options.baseUrl ?? process.env.H3_WORKER_URL ?? "").replace(/\/$/, ""), fetcher = options.fetchImpl ?? fetch;
  const request = async (path: string, init: RequestInit = {}) => {
    const token = options.serviceToken ?? process.env.H3_WORKER_SERVICE_TOKEN;
    if (!baseUrl) throw new Error("H3_WORKER_URL is not configured.");
    if (!token?.trim()) throw new Error("H3_WORKER_SERVICE_TOKEN is not configured.");
    const response = await fetcher(`${baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
    if (!response.ok) throw new Error(`H3 worker request failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    return response;
  };
  return {
    async health() { return (await request("/health")).json(); },
    async ready() { return (await request("/ready")).json(); },
    async capabilities() { return (await request("/v1/capabilities")).json(); },
    async upload(data: Uint8Array, filename: string, mimeType: string) { return (await request("/v1/assets", { method: "POST", body: new Uint8Array(data).buffer, headers: { "Content-Type": mimeType, "X-Filename": filename } })).json() as Promise<H3WorkerAsset>; },
    async create(input: H3GenerationInput, idempotencyKey?: string) { return (await request("/v1/jobs", { method: "POST", body: JSON.stringify(serializeH3Request(input)), headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined })).json() as Promise<H3WorkerJob>; },
    async get(id: string) { return (await request(`/v1/jobs/${encodeURIComponent(id)}`)).json() as Promise<H3WorkerJob>; },
    async cancel(id: string) { return (await request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" })).json() as Promise<H3WorkerJob>; },
    async download(id: string, variant = 0) { return (await request(`/v1/jobs/${encodeURIComponent(id)}/content?variant=${variant}`, { headers: { Accept: "video/mp4" } })).arrayBuffer(); },
    async result(id: string) { return (await request(`/v1/jobs/${encodeURIComponent(id)}/result`)).json(); },
    async run(input: H3GenerationInput) { const created = await this.create(input), started = Date.now(); let job = created; while (!["succeeded", "completed", "failed", "cancelled"].includes(job.status)) { if (Date.now() - started > (options.timeoutMs ?? 30 * 60_000)) throw new Error(`H3 job ${created.id} timed out.`); await delay(options.pollingIntervalMs ?? 2_000); job = await this.get(created.id); } if (job.status !== "succeeded" && job.status !== "completed") { const message = typeof job.error === "string" ? job.error : job.error?.message; throw new Error(message ?? `H3 job ${job.status}.`); } return job; }
  };
}

export function createH3ProviderAdapter(options: Parameters<typeof createH3WorkerClient>[0] = {}): ProviderAdapter {
  const client = createH3WorkerClient(options);
  return { id: "minimax-h3", title: "MiniMax H3 worker", capabilities: ["video.generate"], async invoke(request: ModelInvokeRequest & { model: ModelInfo }) { const input = request.input as unknown as H3GenerationInput, job = await client.run(input); return { modelId: request.model.id, providerId: "minimax-h3", capability: request.capability, output: { jobId: job.id, variants: job.variants ?? input.variants ?? 1 }, raw: { id: job.id, status: job.status } }; } };
}

export function estimateH3Regeneration(durationSeconds: number, options: { rateUsdPerSecond?: number; markupPercent?: number; markupCredits?: number; source?: string; effectiveDate?: string } = {}): H3RegenerationQuote {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 4 || durationSeconds > 15) throw new Error("H3 regeneration duration must be between 4 and 15 seconds.");
  const rate = finiteNonNegative(options.rateUsdPerSecond ?? Number(process.env.MINIMAX_H3_REGEN_USD_PER_SECOND ?? 0.05), "regeneration rate");
  const providerUsd = roundMoney(durationSeconds * rate), baseCredits = Math.ceil(providerUsd * 100);
  const markupPercent = finiteNonNegative(options.markupPercent ?? Number(process.env.BOOJUM_GLOBAL_MARKUP_PERCENT ?? 0), "markup percent");
  const fixedMarkup = Math.ceil(finiteNonNegative(options.markupCredits ?? Number(process.env.BOOJUM_GLOBAL_MARKUP_CREDITS ?? 0), "markup credits"));
  const markupCredits = Math.ceil(baseCredits * markupPercent / 100) + fixedMarkup;
  return { durationSeconds, rateUsdPerSecond: rate, providerUsd, baseCredits, markupCredits, finalCredits: baseCredits + markupCredits, currency: "USD", source: options.source ?? "operator-configured baseline; verify against the current MiniMax catalog", effectiveDate: options.effectiveDate ?? "2026-08-10" };
}

export function createH3RegenerationClient(options: { baseUrl?: string; apiKey?: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number; jobTimeoutMs?: number; downloadTimeoutMs?: number; pollingIntervalMs?: number; maxBaseVideoBytes?: number } = {}) {
  const baseUrl = (options.baseUrl ?? process.env.MINIMAX_API_BASE ?? "https://api.minimax.io").replace(/\/$/, ""), fetcher = options.fetchImpl ?? fetch;
  const request = async (path: string, init: RequestInit = {}) => {
    const key = options.apiKey ?? process.env.MINIMAX_API_KEY;
    if (!key?.trim()) throw new Error("MINIMAX_API_KEY is not configured.");
    const response = await fetcher(`${baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000) });
    if (!response.ok) throw new Error(`MiniMax H3 regeneration failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    return response;
  };
  return {
    configured: Boolean((options.apiKey ?? process.env.MINIMAX_API_KEY)?.trim()),
    async create(input: { prompt: string; baseVideo: Uint8Array | string; idempotencyKey?: string }) {
      const prompt = input.prompt?.trim();
      if (!prompt) throw new Error("H3 regeneration requires the original context prompt.");
      const url = typeof input.baseVideo === "string" ? safeHttpsUrl(input.baseVideo, "base video") : videoDataUrl(input.baseVideo, options.maxBaseVideoBytes ?? positiveIntegerEnv("MINIMAX_H3_REGEN_MAX_BASE_VIDEO_BYTES", 100 * 1024 * 1024));
      const response = await request("/v2/video_regeneration", { method: "POST", headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined, body: JSON.stringify({ model: "MiniMax-H3", content: [{ type: "text", text: prompt }, { type: "video_url", video_url: { url }, role: "base_video" }], resolution: "2K" }) });
      const task = await response.json() as H3RegenerationTask;
      const id = task.task_id ?? task.task?.id;
      if (!id) throw new Error("MiniMax regeneration response did not include task_id.");
      return { id, raw: task };
    },
    async get(id: string) { return (await request(`/v2/query/video_generation/${encodeURIComponent(id)}`)).json() as Promise<H3RegenerationTask>; },
    async run(input: { prompt: string; baseVideo: Uint8Array | string; idempotencyKey?: string }) {
      const created = await this.create(input), started = Date.now(); let state: H3RegenerationTask;
      while (true) {
        if (Date.now() - started > (options.jobTimeoutMs ?? 60 * 60_000)) throw new Error(`MiniMax regeneration task ${created.id} timed out.`);
        await delay(options.pollingIntervalMs ?? 3_000);
        state = await this.get(created.id);
        const status = String(state.task?.status ?? state.status ?? "").toLowerCase();
        if (["succeeded", "completed", "success"].includes(status)) break;
        if (["failed", "error", "cancelled", "canceled"].includes(status)) throw new Error(`MiniMax regeneration task ended with status ${status}.`);
      }
      const resultUrl = state.task?.content?.url;
      if (!resultUrl) throw new Error("MiniMax regeneration completed without a result URL.");
      return { id: created.id, url: safeHttpsUrl(resultUrl, "regeneration result") };
    },
    async download(url: string) { const response = await fetcher(safeHttpsUrl(url, "regeneration result"), { signal: AbortSignal.timeout(options.downloadTimeoutMs ?? 5 * 60_000) }); if (!response.ok) throw new Error(`MiniMax regeneration download failed (${response.status}).`); return response.arrayBuffer(); }
  };
}

export function createH3NodeRunner(options: Parameters<typeof createH3WorkerClient>[0] = {}): NodeRunner {
  const client = createH3WorkerClient(options);
  return async ({ node, params, inputs, context }) => {
    const input = await h3InputFromNode(params, inputs, client.upload), job = await client.run(input), variants = job.variants ?? input.variants ?? 1, assets = [];
    await mkdir(join(context.outputDirectory, "assets"), { recursive: true });
    for (let variant = 0; variant < variants; variant++) { const bytes = Buffer.from(await client.download(job.id, variant)), filename = `${node.id}-${job.id}-${variant}.mp4`, path = join(context.outputDirectory, "assets", filename); await writeFile(path, bytes); assets.push({ path, localPath: path, filename, mimeType: "video/mp4" }); }
    return { output: { video: assets[0], videos: assets, provider: "minimax-h3", model: "MiniMaxAI/MiniMax-H3", providerJobId: job.id, metadata: job.metadata, actualCost: null }, provenance: { provider: "minimax-h3", model: "MiniMaxAI/MiniMax-H3" }, providerUsage: { provider: "minimax-h3", model: "MiniMaxAI/MiniMax-H3", nodeId: node.id, nodeType: node.type, externalId: job.id, status: "succeeded", estimatedCost: null, actualCost: null, pricingHint: "self-hosted-worker" } };
  };
}

async function h3InputFromNode(params: Record<string, unknown>, inputs: Record<string, unknown>, upload: (data: Uint8Array, filename: string, mimeType: string) => Promise<H3WorkerAsset>): Promise<H3GenerationInput> {
  const references: H3Reference[] = Array.isArray(params.references) ? params.references as H3Reference[] : [];
  for (const [id, role, kind] of [["firstFrame", "firstFrame", "image"], ["lastFrame", "lastFrame", "image"], ["referenceImage", "reference", "image"], ["referenceVideo", "reference", "video"], ["referenceAudio", "reference", "audio"]] as const) {
    for (const value of inputValues(inputs[id])) {
      const asset = await uploadInput(value, upload);
      if (asset) references.push({ kind, role, uri: asset.uri });
    }
  }
  return { prompt: String(params.prompt ?? inputs.prompt ?? ""), duration: Number(params.duration ?? params.duration_seconds ?? 5), aspectRatio: String(params.aspectRatio ?? params.aspect_ratio ?? "auto"), seed: params.seed === undefined ? undefined : Number(params.seed), variants: Number(params.variants ?? params.num_outputs_per_prompt ?? 1), quality: params.quality === "high" ? "high" : "lossless", renderMode: params.quality_mode === "preview" ? "preview" : "final", turboLora: params.turbo_lora === true, inferenceSteps: params.num_inference_steps === undefined ? undefined : Number(params.num_inference_steps), references };
}
function inputValues(value: unknown): unknown[] { return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]; }
async function uploadInput(value: unknown, upload: (data: Uint8Array, filename: string, mimeType: string) => Promise<H3WorkerAsset>): Promise<H3WorkerAsset | null> {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.uri === "string") return { id: "external", uri: safeUri(input.uri), mimeType: String(input.mimeType ?? "application/octet-stream") };
  if (typeof input.dataBase64 !== "string") return null;
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (!bytes.length) throw new Error("H3 input asset is empty.");
  return upload(bytes, String(input.filename ?? "input.bin"), String(input.mimeType ?? "application/octet-stream"));
}
function validateReferences(references: H3Reference[]) { const counts = { image: 0, video: 0, audio: 0 }; for (const reference of references) counts[reference.kind]++; if (counts.image > 9 || counts.video > 3 || counts.audio > 3 || references.length > 12) throw new Error("H3 Ref2VA supports up to 9 images, 3 videos, 3 audio clips, and 12 files total."); if (counts.audio && !counts.image && !counts.video) throw new Error("H3 audio references require at least one image or video reference."); }
function safeUri(value: string) { const uri = value?.trim(); if (!/^(?:https?:\/\/|file:\/\/\/)/i.test(uri)) throw new Error("H3 reference URI must use https, http, or a worker-visible file URI."); if (uri.includes("..")) throw new Error("H3 reference URI cannot contain path traversal."); return uri; }
function integerRange(value: number, min: number, max: number, label: string) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`); return value; }
function nonNegative(value: number) { if (!Number.isFinite(value) || value < 0) throw new Error("startTimeSeconds must be non-negative."); return value; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function finiteNonNegative(value: number, label: string) { if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number.`); return value; }
function roundMoney(value: number) { return Math.round(value * 1_000_000) / 1_000_000; }
function positiveIntegerEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function videoDataUrl(value: Uint8Array, limit: number) { if (!value.byteLength || value.byteLength > limit) throw new Error(`Base video must be between 1 and ${limit} bytes.`); return `data:video/mp4;base64,${Buffer.from(value).toString("base64")}`; }
function safeHttpsUrl(value: string, label: string) { let url: URL; try { url = new URL(value); } catch { throw new Error(`${label} URL is invalid.`); } if (url.protocol !== "https:") throw new Error(`${label} URL must use HTTPS.`); if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(url.hostname)) throw new Error(`${label} URL cannot target a private host.`); return url.toString(); }
