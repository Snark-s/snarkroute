import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeRunner } from "@snarkroute/executor";
import { cameraPathForH3Max, compileCameraPathPrompt } from "./camera.js";
import type { H3GenerationInput, H3HostedModelVariant, H3Reference } from "./index.js";

export type H3HostedEndpoint =
  | "minimax/h3-max/text-to-video"
  | "minimax/h3-max/image-to-video"
  | "minimax/h3-max/reference-to-video"
  | "minimax/h3-max/camera-controls"
  | "minimax/h3-max-turbo/text-to-video"
  | "minimax/h3-max-turbo/image-to-video";

export type H3HostedRequest = {
  endpoint: H3HostedEndpoint;
  body: Record<string, unknown>;
  warnings: string[];
  provenance: { owner: "fal"; upstream: "MiniMaxAI/MiniMax-H3"; variant: H3HostedModelVariant; nativeCameraAdapter: boolean };
};

export type H3HostedResult = {
  requestId: string;
  endpoint: H3HostedEndpoint;
  video: { url: string; content_type?: string; file_name?: string; file_size?: number };
  expanded_prompt?: string | null;
  seed?: number;
  timings?: Record<string, unknown>;
  latency: { acceptedMs: number; generationMs: number; totalMs: number };
  raw: Record<string, unknown>;
};

export type H3HostedErrorCode = "auth" | "insufficient_credits" | "rate_limit" | "moderation" | "unsupported_parameter" | "invalid_asset" | "generation_failed" | "provider_error";

export class H3HostedError extends Error {
  readonly name = "H3HostedError";
  constructor(message: string, readonly code: H3HostedErrorCode, readonly status?: number, readonly retryable = false, readonly details?: unknown) { super(message); }
}

export function estimateH3HostedCost(input: { variant: H3HostedModelVariant; duration: number; resolution: "480P" | "768P" | "1080P"; endpoint?: H3HostedEndpoint; now?: Date }) {
  const referenceEndpoint = input.endpoint === "minimax/h3-max/reference-to-video";
  const promotional = !referenceEndpoint && (input.now ?? new Date()).getTime() < Date.parse("2026-09-15T00:00:00Z");
  const listRates = input.variant === "h3_max_turbo"
    ? { "480P": 0.025, "768P": 0.04, "1080P": 0.08 }
    : { "480P": 0.05, "768P": 0.08, "1080P": 0.16 };
  const rateUsdPerSecond = listRates[input.resolution] * (promotional ? 0.5 : 1);
  return {
    amountUsd: Number((input.duration * rateUsdPerSecond).toFixed(6)),
    rateUsdPerSecond,
    currency: "USD" as const,
    confidence: "exact-output-only" as const,
    promotion: promotional ? "fal launch promotion through 2026-09-14" : null,
    excludesReferenceTokenCharges: true,
    source: referenceEndpoint
      ? "https://fal.ai/models/minimax/h3-max/reference-to-video"
      : `https://fal.ai/models/minimax/${input.variant === "h3_max_turbo" ? "h3-max-turbo" : "h3-max"}/text-to-video`
  };
}

export function serializeH3HostedRequest(input: H3GenerationInput & { modelVariant: H3HostedModelVariant; resolution?: "480P" | "768P" | "1080P"; promptExpansionMode?: "disabled" | "balanced" | "quality" }): H3HostedRequest {
  let prompt = input.prompt?.trim();
  if (!prompt) throw new Error("MiniMax H3 Max requires a prompt.");
  if (!Number.isInteger(input.duration) || input.duration < 5 || input.duration > 15) throw new Error("MiniMax H3 Max duration must be an integer between 5 and 15 seconds.");
  if ((input.variants ?? 1) !== 1) throw new Error("The fal H3 Max endpoints generate one variant per request; create parallel route jobs for multiple variants.");
  if (input.identityTransfer?.enabled) throw new Error("FaceSwap identity transfer is a local MiniMax H3 Ref2VA LoRA and is not available on hosted H3 Max.");
  if (input.visualModifier?.enabled) throw new Error("Visual LoRA modifiers require local h3_base and cannot be applied to hosted H3 profiles.");
  const variant = input.modelVariant, references = input.references ?? [], first = references.filter((reference) => reference.role === "firstFrame"), last = references.filter((reference) => reference.role === "lastFrame"), targetAudio = references.filter((reference) => reference.role === "targetAudio"), semantic = references.filter((reference) => !reference.role || reference.role === "reference");
  if (first.length > 1 || last.length > 1) throw new Error("H3 Max accepts at most one first frame and one last frame.");
  if (targetAudio.length > 1 || targetAudio.some((reference) => reference.kind !== "audio")) throw new Error("H3 Max accepts at most one audio reference with role=targetAudio.");
  if ([...first, ...last].some((reference) => reference.kind !== "image")) throw new Error("H3 Max first and last frames must be images.");
  validateHostedReferences(semantic);
  const resolution = input.resolution ?? (variant === "h3_max_turbo" ? "480P" : "768P");
  const common: Record<string, unknown> = { prompt, duration: input.duration, resolution, enable_safety_checker: true, prompt_expansion_mode: input.promptExpansionMode ?? "disabled", ...(input.seed === undefined ? {} : { seed: integerSeed(input.seed) }) };
  const warnings: string[] = [];
  let endpoint: H3HostedEndpoint;
  let body: Record<string, unknown>;

  const nativeCamera = Boolean(input.cameraPath && input.cameraControlMode !== "prompt" && variant === "h3_max");
  if (nativeCamera) {
    if (semantic.length || targetAudio.length || last.length || first.length !== 1) throw new Error("H3 Max native camera controls require exactly one first-frame image and cannot be mixed with last-frame, target-audio, or semantic references.");
    const compiled = cameraPathForH3Max(input.cameraPath!);
    warnings.push(...compiled.warnings);
    endpoint = "minimax/h3-max/camera-controls";
    body = { ...common, image_url: first[0]!.uri, camera_trajectory: compiled.camera_trajectory };
  } else if (semantic.length) {
    if (variant === "h3_max_turbo") throw new Error("H3 Max Turbo has no reference-to-video endpoint. Use h3_max or local h3_base Ref2VA.");
    if (first.length || last.length || targetAudio.length) throw new Error("H3 Max keyframes/target audio and semantic references use different endpoints and cannot be mixed in one request.");
    endpoint = "minimax/h3-max/reference-to-video";
    body = {
      ...common,
      aspect_ratio: hostedAspectRatio(input.aspectRatio, true),
      reference_image_urls: semantic.filter((reference) => reference.kind === "image").map((reference) => reference.uri),
      reference_video_urls: semantic.filter((reference) => reference.kind === "video").map((reference) => reference.uri),
      reference_audio_urls: semantic.filter((reference) => reference.kind === "audio").map((reference) => reference.uri)
    };
  } else if (first.length || last.length) {
    endpoint = `minimax/${variant === "h3_max" ? "h3-max" : "h3-max-turbo"}/image-to-video`;
    body = { ...common, ...(first[0] ? { image_url: first[0].uri } : {}), ...(last[0] ? { end_image_url: last[0].uri } : {}), ...(targetAudio[0] ? { target_audio_url: targetAudio[0].uri } : {}) };
  } else {
    endpoint = `minimax/${variant === "h3_max" ? "h3-max" : "h3-max-turbo"}/text-to-video`;
    body = { ...common, aspect_ratio: hostedAspectRatio(input.aspectRatio, false), ...(targetAudio[0] ? { target_audio_url: targetAudio[0].uri } : {}) };
  }
  if (input.cameraPath && !nativeCamera) {
    prompt = `${prompt}\n${compileCameraPathPrompt(input.cameraPath)}`;
    body.prompt = prompt;
    warnings.push(variant === "h3_max_turbo" ? "H3 Max Turbo has no native camera-control endpoint; CameraPath was compiled to prompt guidance." : "CameraPath was explicitly compiled to prompt guidance.");
  }
  return { endpoint, body, warnings, provenance: { owner: "fal", upstream: "MiniMaxAI/MiniMax-H3", variant, nativeCameraAdapter: nativeCamera } };
}

export function createH3HostedClient(options: { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch; pollingIntervalMs?: number; timeoutMs?: number } = {}) {
  const baseUrl = (options.baseUrl ?? "https://queue.fal.run").replace(/\/$/, ""), fetcher = options.fetchImpl ?? fetch;
  const authenticated = async (url: string, init: RequestInit = {}) => {
    const key = options.apiKey ?? process.env.FAL_KEY;
    if (!key?.trim()) throw new Error("FAL_KEY is not configured on the server.");
    const response = await fetcher(url, { ...init, headers: { Authorization: `Key ${key.trim()}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok) throw normalizeH3HostedError(response.status, (await response.text()).slice(0, 4000));
    return response;
  };
  const requestUrl = (endpoint: string, requestId?: string, suffix = "") => `${baseUrl}/${requestId ? queueRoot(endpoint) : endpoint}${requestId ? `/requests/${encodeURIComponent(requestId)}${suffix}` : ""}`;
  return {
    configured: Boolean((options.apiKey ?? process.env.FAL_KEY)?.trim()),
    async submit(request: H3HostedRequest, signal?: AbortSignal) { const response = await authenticated(requestUrl(request.endpoint), { method: "POST", body: JSON.stringify(request.body), signal }); const payload = await response.json() as { request_id?: string }; if (!payload.request_id) throw new Error("fal H3 response did not include request_id."); return { requestId: payload.request_id, endpoint: request.endpoint }; },
    async status(endpoint: H3HostedEndpoint, requestId: string, signal?: AbortSignal) { return (await authenticated(requestUrl(endpoint, requestId, "/status"), { signal })).json() as Promise<{ status?: string; error?: string; logs?: Array<{ message?: string }> }>; },
    async result(endpoint: H3HostedEndpoint, requestId: string, signal?: AbortSignal) { return (await authenticated(requestUrl(endpoint, requestId), { signal })).json() as Promise<Record<string, unknown>>; },
    async cancel(endpoint: H3HostedEndpoint, requestId: string) { return authenticated(requestUrl(endpoint, requestId, "/cancel"), { method: "PUT" }); },
    async run(request: H3HostedRequest, signal?: AbortSignal, callbacks: { onSubmitted?: (requestId: string) => void | Promise<void>; onStatus?: (status: { status?: string; error?: string; logs?: Array<{ message?: string }> }) => void | Promise<void> } = {}): Promise<H3HostedResult> {
      const started = Date.now(), submitted = await this.submit(request, signal), acceptedAt = Date.now();
      await callbacks.onSubmitted?.(submitted.requestId);
      while (true) {
        if (signal?.aborted) { await this.cancel(submitted.endpoint, submitted.requestId).catch(() => undefined); throw signal.reason instanceof Error ? signal.reason : new Error("fal H3 request was cancelled."); }
        if (Date.now() - started > (options.timeoutMs ?? 45 * 60_000)) throw new Error(`fal H3 request ${submitted.requestId} timed out.`);
        const status = await this.status(submitted.endpoint, submitted.requestId, signal), state = String(status.status ?? "").toUpperCase();
        await callbacks.onStatus?.(status);
        if (state === "COMPLETED") break;
        if (["FAILED", "CANCELLED", "CANCELED"].includes(state)) throw normalizeH3HostedError(undefined, status.error ?? `fal H3 request ended with status ${state}.`);
        await delay(options.pollingIntervalMs ?? 2_000, signal);
      }
      const raw = await this.result(submitted.endpoint, submitted.requestId, signal), payload = isRecord(raw.data) ? raw.data : raw, video = isRecord(payload.video) ? payload.video : undefined;
      if (!video || typeof video.url !== "string") throw new Error("fal H3 completed without a video URL.");
      const completedAt = Date.now();
      return { requestId: submitted.requestId, endpoint: submitted.endpoint, video: video as H3HostedResult["video"], expanded_prompt: typeof payload.expanded_prompt === "string" ? payload.expanded_prompt : null, seed: typeof payload.seed === "number" ? payload.seed : undefined, timings: isRecord(payload.timings) ? payload.timings : undefined, latency: { acceptedMs: acceptedAt - started, generationMs: completedAt - acceptedAt, totalMs: completedAt - started }, raw };
    },
    async resume(request: H3HostedRequest, requestId: string, signal?: AbortSignal, callbacks: { onStatus?: (status: { status?: string; error?: string; logs?: Array<{ message?: string }> }) => void | Promise<void> } = {}): Promise<H3HostedResult> {
      const started = Date.now();
      while (true) {
        const status = await this.status(request.endpoint, requestId, signal), state = String(status.status ?? "").toUpperCase();
        await callbacks.onStatus?.(status);
        if (state === "COMPLETED") break;
        if (["FAILED", "CANCELLED", "CANCELED"].includes(state)) throw normalizeH3HostedError(undefined, status.error ?? `fal H3 request ended with status ${state}.`);
        if (Date.now() - started > (options.timeoutMs ?? 45 * 60_000)) throw new Error(`fal H3 request ${requestId} timed out.`);
        await delay(options.pollingIntervalMs ?? 2_000, signal);
      }
      const raw = await this.result(request.endpoint, requestId, signal), payload = isRecord(raw.data) ? raw.data : raw, video = isRecord(payload.video) ? payload.video : undefined;
      if (!video || typeof video.url !== "string") throw new Error("fal H3 completed without a video URL.");
      const completedAt = Date.now();
      return { requestId, endpoint: request.endpoint, video: video as H3HostedResult["video"], expanded_prompt: typeof payload.expanded_prompt === "string" ? payload.expanded_prompt : null, seed: typeof payload.seed === "number" ? payload.seed : undefined, timings: isRecord(payload.timings) ? payload.timings : undefined, latency: { acceptedMs: 0, generationMs: completedAt - started, totalMs: completedAt - started }, raw };
    },
    async download(url: string, signal?: AbortSignal) { const parsed = new URL(url); if (parsed.protocol !== "https:") throw new Error("fal H3 result URL must use HTTPS."); const response = await fetcher(parsed, { signal }); if (!response.ok) throw new Error(`fal H3 video download failed (${response.status}).`); return response.arrayBuffer(); }
  };
}

export function createH3HostedNodeRunner(options: Parameters<typeof createH3HostedClient>[0] = {}): NodeRunner {
  const client = createH3HostedClient(options);
  return async ({ node, params, inputs, context }) => {
    const input = await hostedInputFromNode(params, inputs), variant = input.modelVariant;
    if (variant !== "h3_max" && variant !== "h3_max_turbo") throw new Error("The hosted H3 runner requires h3_max or h3_max_turbo.");
    const request = serializeH3HostedRequest({ ...input, modelVariant: variant }), quote = estimateH3HostedCost({ variant, duration: input.duration, resolution: request.body.resolution as "480P" | "768P" | "1080P", endpoint: request.endpoint }), result = await client.run(request, context.signal);
    const downloadStarted = Date.now();
    const bytes = Buffer.from(await client.download(result.video.url, context.signal));
    const downloadMs = Date.now() - downloadStarted;
    await mkdir(join(context.outputDirectory, "assets"), { recursive: true });
    const filename = `${node.id}-${result.requestId}.mp4`, path = join(context.outputDirectory, "assets", filename); await writeFile(path, bytes);
    const model = variant === "h3_max" ? "fal/minimax-h3-max" : "fal/minimax-h3-max-turbo";
    return { output: { video: { path, localPath: path, filename, mimeType: result.video.content_type ?? "video/mp4" }, provider: "fal", model, providerJobId: result.requestId, warnings: request.warnings, expandedPrompt: result.expanded_prompt, timings: result.timings, latency: { ...result.latency, downloadMs, totalWithDownloadMs: result.latency.totalMs + downloadMs }, estimatedCost: quote.amountUsd, actualCost: null }, logs: request.warnings, provenance: { provider: "fal", model, upstream: request.provenance.upstream, variant, endpoint: request.endpoint, nativeCameraAdapter: request.provenance.nativeCameraAdapter }, providerUsage: { provider: "fal", model, nodeId: node.id, nodeType: node.type, externalId: result.requestId, status: "succeeded", estimatedCost: quote.amountUsd, actualCost: null, pricingHint: "fal-catalog" } };
  };
}

async function hostedInputFromNode(params: Record<string, unknown>, inputs: Record<string, unknown>): Promise<H3GenerationInput> {
  const references: H3Reference[] = Array.isArray(params.references) ? await Promise.all((params.references as H3Reference[]).map(async (reference) => ({ ...reference, uri: await hostedAssetUri(reference.uri, reference.kind) }))) : [];
  for (const [id, role, kind] of [["firstFrame", "firstFrame", "image"], ["lastFrame", "lastFrame", "image"], ["referenceImage", "reference", "image"], ["referenceVideo", "reference", "video"], ["referenceAudio", "reference", "audio"]] as const) {
    for (const value of values(inputs[id])) { const uri = await hostedValueUri(value, kind); if (uri) references.push({ kind, role, uri }); }
  }
  if (!references.some((reference) => reference.role === "firstFrame")) { const uri = await hostedValueUri(values(inputs.images)[0], "image"); if (uri) references.push({ kind: "image", role: "firstFrame", uri }); }
  const modelVariant = String(params.modelVariant ?? params.model_variant ?? params.providerModelId ?? params.model ?? "h3_max_turbo").includes("turbo") ? "h3_max_turbo" : "h3_max";
  return { prompt: String(params.prompt ?? inputs.prompt ?? ""), duration: Number(params.duration ?? params.duration_seconds ?? 5), aspectRatio: String(params.aspectRatio ?? params.aspect_ratio ?? "16:9"), seed: params.seed === undefined ? undefined : Number(params.seed), variants: Number(params.variants ?? 1), renderMode: params.quality_mode === "final" ? "final" : "preview", modelVariant, references, cameraPath: hostedCameraPath(params.cameraPath ?? params.camera_path), cameraControlMode: params.cameraControlMode === "prompt" || params.camera_control_mode === "prompt" ? "prompt" : "auto", resolution: params.resolution === "480P" || params.resolution === "768P" || params.resolution === "1080P" ? params.resolution : undefined };
}
function hostedCameraPath(value: unknown): H3GenerationInput["cameraPath"] { if (value === undefined || value === null || value === "") return undefined; if (typeof value === "string") { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("CameraPath must be valid JSON."); } if (!isRecord(parsed)) throw new Error("CameraPath must be a JSON object."); return parsed as H3GenerationInput["cameraPath"]; } if (!isRecord(value)) throw new Error("CameraPath must be an object."); return value as H3GenerationInput["cameraPath"]; }

async function hostedValueUri(value: unknown, kind: H3Reference["kind"]): Promise<string | null> { if (!isRecord(value)) return null; if (typeof value.dataBase64 === "string") return `data:${String(value.mimeType ?? mimeForKind(kind))};base64,${value.dataBase64.replace(/^data:[^;]+;base64,/i, "")}`; const localPath = typeof value.localPath === "string" ? value.localPath : typeof value.path === "string" ? value.path : undefined; if (localPath) return dataUri(await readFile(localPath), String(value.mimeType ?? mimeForKind(kind))); return typeof value.uri === "string" ? hostedAssetUri(value.uri, kind) : null; }
async function hostedAssetUri(uri: string, kind: H3Reference["kind"]) { if (/^https:\/\//i.test(uri) || /^data:/i.test(uri)) return uri; if (/^file:\/\//i.test(uri)) return dataUri(await readFile(new URL(uri)), mimeForKind(kind)); throw new Error("Hosted H3 reference inputs must use HTTPS, data URIs, or readable local file URIs."); }
function dataUri(value: Uint8Array, mimeType: string) { if (!value.byteLength) throw new Error("Hosted H3 input asset is empty."); return `data:${mimeType};base64,${Buffer.from(value).toString("base64")}`; }
function mimeForKind(kind: H3Reference["kind"]) { return kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/wav"; }
function validateHostedReferences(references: H3Reference[]) { if (references.length > 12) throw new Error("H3 Max reference-to-video supports at most 12 reference files total."); }
function hostedAspectRatio(value: string | undefined, adaptive: boolean) { const ratio = value?.trim() || (adaptive ? "adaptive" : "16:9"); const allowed = adaptive ? ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] : ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]; if (!allowed.includes(ratio)) throw new Error(`Unsupported H3 Max aspect ratio: ${ratio}.`); return ratio; }
function integerSeed(value: number) { if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) throw new Error("seed must be an integer between 0 and 2147483647."); return value; }
function values(value: unknown) { return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function delay(ms: number, signal?: AbortSignal) { return new Promise<void>((resolve, reject) => { const timeout = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(signal.reason instanceof Error ? signal.reason : new Error("Request cancelled.")); }, { once: true }); }); }
function queueRoot(endpoint: string) { const parts = endpoint.split("/"); return parts.length >= 2 ? parts.slice(0, 2).join("/") : endpoint; }

export function normalizeH3HostedError(status: number | undefined, body: unknown): H3HostedError {
  const details = parseProviderBody(body);
  const message = providerMessage(details) || `fal H3 request failed${status ? ` (${status})` : ""}.`;
  const text = `${message} ${typeof body === "string" ? body : ""}`.toLowerCase();
  if (status === 402 || /insufficient|credit|balance|payment/.test(text)) return new H3HostedError(message, "insufficient_credits", status, false, details);
  if (status === 401 || status === 403 || /api.?key|unauthori[sz]ed|authentication|invalid key/.test(text)) return new H3HostedError(message, "auth", status, false, details);
  if (status === 429 || /rate.?limit|too many requests/.test(text)) return new H3HostedError(message, "rate_limit", status, true, details);
  if (/moderation|safety|content policy|nsfw|blocked prompt/.test(text)) return new H3HostedError(message, "moderation", status, false, details);
  if (/image|video|audio|asset|file|url/.test(text) && /invalid|unsupported|decode|download|format|size|duration/.test(text)) return new H3HostedError(message, "invalid_asset", status, false, details);
  if (status === 422 || /duration|resolution|aspect|unsupported|validation|invalid input|extra_forbidden/.test(text)) return new H3HostedError(message, "unsupported_parameter", status, false, details);
  if (/generation|inference|gpu|failed|cancelled|canceled/.test(text)) return new H3HostedError(message, "generation_failed", status, true, details);
  return new H3HostedError(message, "provider_error", status, Boolean(status && status >= 500), details);
}

function parseProviderBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try { return JSON.parse(body); } catch { return body; }
}
function providerMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  for (const key of ["detail", "message", "error"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    const nested = providerMessage(candidate);
    if (nested) return nested;
  }
  return undefined;
}
