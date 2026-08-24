import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ModelGateway, unknownPricingQuote, type ModelCapability, type ModelInfo, type ModelInvokeResult, type ModelPricingInput, type PricingQuote, type ProviderAdapter } from "@snarkroute/core";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";

export const KIE_BASE_URL = "https://api.kie.ai";
export const KIE_UPLOAD_BASE_URL = "https://kieai.redpandaai.co";
export const KIE_MISSING_KEY_MESSAGE = "KIE_API_KEY is not configured. Add it in Settings or the server environment.";
export const KIE_PROVIDER_MANIFEST = {
  id: "kie",
  title: "KIE.ai",
  apiKeyEnv: "KIE_API_KEY",
  baseUrl: KIE_BASE_URL,
  uploadBaseUrl: KIE_UPLOAD_BASE_URL,
  modelDiscovery: "official_documentation_curated",
  capabilities: ["text.generate", "image.generate", "image.edit", "image.reference", "video.generate"] as const
};

export type KieFetch = typeof fetch;
export type KieClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  uploadBaseUrl?: string;
  fetch?: KieFetch;
  outputDirectory?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type KieTaskRecord = {
  taskId: string;
  model?: string;
  state: "waiting" | "queuing" | "generating" | "success" | "fail" | string;
  resultJson?: string | Record<string, unknown>;
  failCode?: string;
  failMsg?: string;
  progress?: number;
  creditsConsumed?: number;
};

export type DocumentedKieModel = ModelInfo & {
  canonicalModelId: string;
  providerNativeModelId: string;
  parameters: Array<Record<string, unknown>>;
  constraints?: Record<string, unknown>;
};

const documentedModels: DocumentedKieModel[] = [
  kieModel("gpt-5-2", "gpt-5.2", "GPT-5.2", ["text.generate"], ["text", "image"], ["text"], [select("reasoning_effort", ["low", "medium", "high"], "medium"), bool("web_search", false)], { chatEndpoint: "/gpt-5-2/v1/chat/completions", maxImageInputs: 8 }),
  kieModel("kling-3.0/video", "kling-3.0-pro", "Kling 3.0 Pro", ["video.generate"], ["text", "image"], ["video"], [
    select("mode", ["pro"], "pro"), select("aspect_ratio", ["16:9", "9:16", "1:1"], "16:9"), select("duration", ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"], "5"), bool("sound", true)
  ], { mode: "pro", durationSeconds: [3, 15], firstLastFrame: true, audio: true, multiShot: false, maxImageInputs: 2 }),
  kieModel("bytedance/seedance-2", "seedance-2.0", "Seedance 2.0", ["video.generate"], ["text", "image", "video", "audio"], ["video"], [select("image_mode", ["first_last", "reference"], "first_last"), select("resolution", ["480p", "720p", "1080p"], "720p"), select("aspect_ratio", ["16:9", "9:16", "1:1"], "16:9"), select("duration", ["5", "10", "15"], "5"), bool("return_last_frame", false), bool("generate_audio", false), bool("web_search", false)], { firstLastFrame: true, referenceImages: true, referenceVideo: true, referenceAudio: true, audio: true, mutuallyExclusiveImageModes: true, maxImageInputs: 2 }),
  kieModel("wan/2-6-text-to-video", "wan-2.6", "Wan 2.6 Text to Video", ["video.generate"], ["text"], ["video"], [select("resolution", ["720p", "1080p"], "1080p"), select("duration", ["5", "10", "15"], "5"), bool("multi_shots", false), bool("nsfw_checker", false)]),
  kieModel("wan/2-6-image-to-video", "wan-2.6", "Wan 2.6 Image to Video", ["video.generate"], ["text", "image"], ["video"], [select("resolution", ["720p", "1080p"], "1080p"), select("duration", ["5", "10", "15"], "5"), bool("multi_shots", false), bool("nsfw_checker", false)], { requiredImageInputs: 1, maxImageInputs: 1 }),
  kieModel("nano-banana-pro", "nano-banana-pro", "Nano Banana Pro", ["image.generate", "image.edit", "image.reference"], ["text", "image"], ["image"], [select("aspect_ratio", ["1:1", "16:9", "9:16", "4:3", "3:4"], "1:1"), select("resolution", ["1K", "2K", "4K"], "1K"), select("output_format", ["png", "jpg"], "png")], { maxImageInputs: 8 }),
  kieModel("bytedance/seedream-v4-edit", "seedream-4.0-edit", "Seedream 4.0 Edit", ["image.edit", "image.reference"], ["text", "image"], ["image"], [select("image_size", ["square_hd"], "square_hd"), select("image_resolution", ["1K", "2K", "4K"], "1K"), number("max_images", 1, 4, 1), number("seed", 0, 2147483647, 0), bool("nsfw_checker", true)], { requiredImageInputs: 1 }),
  kieModel("qwen2/image-edit", "qwen2-image-edit", "Qwen2 Image Edit", ["image.edit"], ["text", "image"], ["image"], [select("image_size", ["1:1", "16:9", "9:16"], "1:1"), select("output_format", ["png", "jpg"], "png"), number("seed", 0, 2147483647, 0)], { requiredImageInputs: 1, maxImageInputs: 1 }),
  kieModel("flux-2/pro-text-to-image", "flux-2-pro", "FLUX.2 Pro", ["image.generate"], ["text"], ["image"], [select("aspect_ratio", ["1:1", "16:9", "9:16"], "1:1"), select("resolution", ["1K", "2K"], "1K"), bool("nsfw_checker", false)])
];

export function listDocumentedKieModels(): DocumentedKieModel[] {
  return documentedModels.map((model) => ({ ...model, capabilities: [...model.capabilities], inputTypes: [...(model.inputTypes ?? [])], outputTypes: [...(model.outputTypes ?? [])], parameters: model.parameters.map((parameter) => ({ ...parameter })), constraints: model.constraints ? { ...model.constraints } : undefined }));
}

export function createKieClient(options: KieClientOptions = {}) {
  const apiKey = options.apiKey?.trim() || process.env.KIE_API_KEY?.trim() || "";
  const baseUrl = (options.baseUrl ?? process.env.KIE_API_BASE_URL ?? KIE_BASE_URL).replace(/\/$/, "");
  const uploadBaseUrl = (options.uploadBaseUrl ?? process.env.KIE_UPLOAD_BASE_URL ?? KIE_UPLOAD_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const headers = () => {
    if (!apiKey) throw new KieError("auth_error", KIE_MISSING_KEY_MESSAGE, false);
    return { Authorization: `Bearer ${apiKey}` };
  };
  return {
    configured: Boolean(apiKey),
    async listModels() { return listDocumentedKieModels(); },
    async getCredits(): Promise<number> {
      const data = await requestJson(fetchImpl, `${baseUrl}/api/v1/chat/credit`, { headers: headers() });
      return numberValue(data.data) ?? 0;
    },
    async createTask(model: string, input: Record<string, unknown>): Promise<string> {
      const data = await requestJson(fetchImpl, `${baseUrl}/api/v1/jobs/createTask`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ model, input }) });
      const taskId = stringValue(objectRecord(data.data).taskId) ?? stringValue(objectRecord(data.data).task_id);
      if (!taskId) throw new KieError("invalid_response", "KIE accepted the request without returning a task id.", false);
      return taskId;
    },
    async getTask(taskId: string): Promise<KieTaskRecord> {
      const data = await requestJson(fetchImpl, `${baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: headers() });
      const record = objectRecord(data.data);
      return { taskId: stringValue(record.taskId) ?? taskId, model: stringValue(record.model), state: stringValue(record.state) ?? "waiting", resultJson: record.resultJson as KieTaskRecord["resultJson"], failCode: stringValue(record.failCode), failMsg: stringValue(record.failMsg), progress: numberValue(record.progress), creditsConsumed: numberValue(record.creditsConsumed) };
    },
    async uploadFile(path: string): Promise<string> {
      const bytes = await readFile(path);
      const form = new FormData();
      form.append("file", new Blob([bytes]), basename(path));
      form.append("uploadPath", "snarkroute/inputs");
      form.append("fileName", `${randomUUID()}-${basename(path)}`);
      const data = await requestJson(fetchImpl, `${uploadBaseUrl}/api/file-stream-upload`, { method: "POST", headers: headers(), body: form });
      const record = objectRecord(data.data);
      const url = stringValue(record.fileUrl) ?? stringValue(record.downloadUrl);
      if (!url) throw new KieError("upload_failed", "KIE file upload completed without a file URL.", true);
      return url;
    },
    async downloadUrl(url: string): Promise<string> {
      try {
        const data = await requestJson(fetchImpl, `${baseUrl}/api/v1/common/download-url`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        return stringValue(data.data) ?? url;
      } catch { return url; }
    },
    async chatCompletion(model: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const endpoint = model === "gpt-5-2" ? "/gpt-5-2/v1/chat/completions" : undefined;
      if (!endpoint) throw new KieError("unsupported_model", `KIE chat model ${model} is not registered.`, false);
      return requestJson(fetchImpl, `${baseUrl}${endpoint}`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
  };
}

export class KieError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly details?: Record<string, unknown>) { super(message); this.name = "KieError"; }
}

export function createKieProviderAdapter(options: KieClientOptions = {}): ProviderAdapter {
  const client = createKieClient(options);
  return {
    id: "kie",
    title: "KIE.ai",
    capabilities: unique(listDocumentedKieModels().flatMap((model) => model.capabilities)),
    listModels: async () => client.listModels(),
    pricingResolver: { estimate: estimateKiePricingQuote },
    async invoke(request): Promise<ModelInvokeResult> {
      const urls = await uploadInputs(client, request.input);
      if (request.capability === "text.generate") {
        const prompt = stringValue(request.input.prompt) ?? "";
        if (!prompt) throw new KieError("invalid_request", "KIE text generation requires a prompt.", false);
        const userContent: unknown = urls.images.length > 0
          ? [{ type: "text", text: prompt }, ...urls.images.map((url) => ({ type: "image_url", image_url: { url } }))]
          : prompt;
        const systemPrompt = stringValue(request.input.systemPrompt);
        const response = await client.chatCompletion(request.model.id, {
          messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: userContent }],
          ...kieChatParameters(request.parameters ?? {})
        });
        const text = firstChatText(response);
        if (!text) throw new KieError("missing_result", "KIE chat completion returned no text.", false);
        const usage = objectRecord(response.usage);
        return { modelId: request.model.id, providerId: "kie", capability: request.capability, output: { text, output: response }, usage, raw: response };
      }
      const input = buildKieTaskInput(request.model.id, request.input, request.parameters ?? {}, urls);
      const taskId = await client.createTask(request.model.id, input);
      const onProviderTaskCreated = request.metadata?.onProviderTaskCreated;
      if (typeof onProviderTaskCreated === "function") await onProviderTaskCreated(taskId);
      const task = await pollKieTask(client, taskId, options, request.metadata?.signal as AbortSignal | undefined);
      const resultUrls = kieResultUrls(task.resultJson);
      if (resultUrls.length === 0) throw new KieError("missing_result", "KIE task completed without result URLs.", false, { taskId });
      return { modelId: request.model.id, providerId: "kie", capability: request.capability, output: { taskId, resultUrls, creditsConsumed: task.creditsConsumed }, usage: { creditsConsumed: task.creditsConsumed }, raw: task };
    }
  };
}

export function createKieNodeRunner(capability: "text.generate" | "image.generate" | "image.edit" | "image.reference" | "video.generate", options: KieClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const model = stringValue(params.providerModelId) ?? stringValue(params.model);
    if (!model) throw new KieError("invalid_request", "KIE model is required.", false);
    const documented = listDocumentedKieModels().find((entry) => entry.id === model);
    if (!documented || !documented.capabilities.includes(capability)) throw new KieError("unsupported_model", `KIE model ${model} does not support ${capability}.`, false);
    const gateway = new ModelGateway({ models: [documented], adapters: [createKieProviderAdapter({ ...options, outputDirectory: context.outputDirectory })], connections: [{ providerId: "kie", enabled: true, secretRef: "env:KIE_API_KEY" }] });
    const invoke = await gateway.invoke({ capability, modelRef: `model://kie/${model}`, input: { prompt: stringValue(params.prompt) ?? stringValue(inputs.prompt) ?? "", systemPrompt: stringValue(params.systemPrompt) ?? stringValue(inputs.systemPrompt), images: mediaInputs(params.images ?? inputs.images), videos: mediaInputs(params.videos ?? inputs.videos), audios: mediaInputs(params.audios ?? inputs.audios) }, parameters: params, metadata: { signal: context.signal, onProviderTaskCreated: (taskId: string) => context.reportProgress?.(0.05, `provider_job:${taskId}`) } });
    if (capability === "text.generate") {
      const text = stringValue(invoke.output.text);
      if (!text) throw new KieError("missing_result", "KIE text generation completed without text.", false);
      return { output: { text, output: invoke.output.output, provider: "kie", model, providerModel: model, actualUsage: invoke.usage, actualCost: null, actualCostCurrency: null, pricingSource: "provider_actual_usage", status: "succeeded" }, logs: [`Generated text with KIE ${model}.`], providerUsage: kieTextUsageEvent(node.id, node.type, model, invoke.usage), provenance: { provider: "kie", providerModelId: model } };
    }
    const urls = stringArray(invoke.output.resultUrls);
    const outputDirectory = options.outputDirectory ?? context.outputDirectory;
    const assets = await Promise.all(urls.map((url, index) => persistKieResult(url, invoke.output.taskId as string, index, outputDirectory, options)));
    const media = documented.outputTypes?.[0] === "video" ? "video" : documented.outputTypes?.[0] === "audio" ? "audio" : "image";
    const usage = kieUsageEvent(node.id, node.type, model, invoke.output.taskId as string, invoke.output.creditsConsumed);
    return { output: media === "video" ? { video: assets[0], videos: assets, provider: "kie", model, providerJobId: invoke.output.taskId } : media === "audio" ? { audio: assets[0], audios: assets, provider: "kie", model, providerJobId: invoke.output.taskId } : { image: assets[0], images: assets, provider: "kie", model, providerJobId: invoke.output.taskId }, logs: [`KIE task ${invoke.output.taskId} completed.`, `Saved ${assets.length} result asset(s).`], providerUsage: usage, provenance: { provider: "kie", providerModelId: model, taskId: invoke.output.taskId } };
  };
}

export function buildKieTaskInput(model: string, input: Record<string, unknown>, params: Record<string, unknown>, uploaded: { images: string[]; videos: string[]; audios: string[] }): Record<string, unknown> {
  const documented = documentedModels.find((entry) => entry.id === model);
  const allowed = new Set(documented?.parameters.map((parameter) => String(parameter.id)) ?? []);
  const prompt = stringValue(input.prompt);
  const result: Record<string, unknown> = {
    ...providerParameters(params, allowed),
    prompt: model === "kling-3.0/video" && prompt ? kling3FramePrompt(prompt) : prompt
  };
  if (model === "kling-3.0/video") { result.image_urls = uploaded.images; result.mode = "pro"; result.multi_shots = false; }
  else if (model === "bytedance/seedance-2") {
    if (params.image_mode === "reference") result.reference_image_urls = uploaded.images;
    else { result.first_frame_url = uploaded.images[0]; result.last_frame_url = uploaded.images[1]; }
    result.reference_video_urls = uploaded.videos;
    result.reference_audio_urls = uploaded.audios;
    delete result.image_mode;
  }
  else if (model === "wan/2-6-image-to-video") result.image_urls = uploaded.images;
  else if (model === "nano-banana-pro") result.image_input = uploaded.images;
  else if (model === "bytedance/seedream-v4-edit") result.image_urls = uploaded.images;
  else if (model === "qwen2/image-edit") result.image_url = uploaded.images[0];
  if ((model === "kling-3.0/video" || model.startsWith("wan/2-6-")) && result.duration !== undefined) result.duration = String(result.duration);
  if (model === "bytedance/seedance-2" && result.duration !== undefined) result.duration = Number(result.duration);
  return filterDefined(result);
}

export function kieResultUrls(resultJson: unknown): string[] {
  const parsed = typeof resultJson === "string" ? safeJson(resultJson) : resultJson;
  const record = objectRecord(parsed);
  return unique([...stringArray(record.resultUrls), ...stringArray(record.urls), ...[stringValue(record.resultUrl), stringValue(record.url)].filter((value): value is string => Boolean(value))]);
}

export function estimateKiePricingQuote(input: ModelPricingInput): PricingQuote {
  if (input.providerModel === "nano-banana-pro") {
    const resolution = String(input.params.resolution ?? "1K").toUpperCase();
    const microusd = resolution === "4K" ? 120_000 : 90_000;
    return { logicalModel: input.logicalModel, provider: "kie", providerModel: input.providerModel, capability: input.capability, estimatedCost: microusd / 1_000_000, currency: "USD", unit: "image", pricingSource: "kie_public_pricing", confidence: "exact", warnings: [] };
  }
  return unknownPricingQuote(input, "kie_provider_credits", "KIE returns creditsConsumed after completion; no stable USD price was documented for this route.");
}

async function pollKieTask(client: ReturnType<typeof createKieClient>, taskId: string, options: KieClientOptions, signal?: AbortSignal): Promise<KieTaskRecord> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  let interval = options.pollIntervalMs ?? 2_500;
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new KieError("cancelled", "KIE polling cancelled locally.", false, { taskId });
    const task = await client.getTask(taskId);
    if (task.state === "success") return task;
    if (task.state === "fail") throw new KieError(task.failCode || "provider_failed", task.failMsg || "KIE task failed.", false, { taskId });
    await abortableDelay(interval, signal);
    interval = Math.min(10_000, Math.round(interval * 1.4));
  }
  throw new KieError("timeout", `KIE task ${taskId} timed out. The provider task may still be running.`, true, { taskId });
}

async function uploadInputs(client: ReturnType<typeof createKieClient>, input: Record<string, unknown>) {
  const upload = async (items: unknown) => Promise.all(mediaInputs(items).map((item) => item.url ?? client.uploadFile(item.path!)));
  return { images: await upload(input.images), videos: await upload(input.videos), audios: await upload(input.audios) };
}

async function persistKieResult(url: string, taskId: string, index: number, outputDirectory: string, options: KieClientOptions) {
  const client = createKieClient(options);
  const fetchImpl = options.fetch ?? fetch;
  const downloadUrl = await client.downloadUrl(url);
  // The common API returns a temporary public URL. Never forward the KIE key to
  // the result host because it may be on a different origin.
  const response = await fetchImpl(downloadUrl);
  if (!response.ok) throw new KieError("download_failed", `Could not download KIE result (${response.status}).`, true, { taskId });
  const contentType = response.headers.get("content-type")?.split(";")[0] || mimeFromUrl(url);
  const extension = extensionForMime(contentType) ?? (extname(new URL(url).pathname) || ".bin");
  const directory = join(outputDirectory, "assets");
  await mkdir(directory, { recursive: true });
  const filename = `kie-${safeName(taskId)}-${index + 1}${extension}`;
  const path = join(directory, filename);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return { path, filename, mimeType: contentType, resultUrl: url };
}

function kieUsageEvent(nodeId: string, nodeType: string, model: string, taskId: string, credits: unknown): ProviderUsageEvent {
  return { provider: "kie", model, providerModel: model, nodeId, nodeType, externalId: taskId, status: "succeeded", actualCost: null, actualCostCurrency: null, metrics: { kieCreditsConsumed: numberValue(credits) }, pricingSource: "provider_actual_credits" };
}

function kieTextUsageEvent(nodeId: string, nodeType: string, model: string, usage: unknown): ProviderUsageEvent {
  const metrics = objectRecord(usage);
  return { provider: "kie", model, providerModel: model, nodeId, nodeType, status: "succeeded", actualCost: null, actualCostCurrency: null, metrics, pricingSource: "provider_actual_usage" };
}

async function requestJson(fetchImpl: KieFetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetchImpl(url, init); } catch (error) { throw new KieError("network_error", `KIE network request failed: ${safeMessage(error)}`, true); }
  const text = await response.text();
  const data = objectRecord(safeJson(text));
  const code = numberValue(data.code);
  if (!response.ok || code && code !== 200) throw kieHttpError(response.status, code, stringValue(data.msg));
  return data;
}

function kieHttpError(status: number, code?: number, message?: string): KieError {
  if (status === 401 || status === 403 || code === 401) return new KieError("auth_error", "KIE API key is invalid or lacks access.", false);
  if (status === 402 || code === 402) return new KieError("quota_exceeded", "KIE account has insufficient provider credits.", false);
  if (status === 429 || code === 429) return new KieError("rate_limited", "KIE rate limit exceeded.", true);
  if (status >= 500 || (code ?? 0) >= 500) return new KieError("provider_unavailable", `KIE is temporarily unavailable.${message ? ` ${message}` : ""}`, true);
  return new KieError("provider_rejected", `KIE request failed (${code ?? status}).${message ? ` ${message}` : ""}`, false);
}

function kieModel(id: string, canonicalModelId: string, title: string, capabilities: ModelCapability[], inputTypes: string[], outputTypes: string[], parameters: Array<Record<string, unknown>>, constraints?: Record<string, unknown>): DocumentedKieModel {
  return { id, providerId: "kie", providerNativeModelId: id, canonicalModelId, title, capabilities, inputTypes, outputTypes, parameters, constraints, ioContract: { inputs: inputTypes.map((kind) => ({ kind: kind as "text" | "image" | "video" | "audio", minItems: kind === "image" ? Number(constraints?.requiredImageInputs ?? 0) : 0, maxItems: kind === "image" ? Number(constraints?.maxImageInputs ?? 1) : 1 })), outputs: outputTypes.map((kind) => ({ kind: kind as "text" | "image" | "video" | "audio", required: true, minItems: 1, maxItems: 1 })) }, metadata: { documented: true, canonicalModelId, providerConstraints: constraints, parameters } };
}
function select(id: string, options: string[], value: string) { return { id, type: "select", default: value, options: options.map((option) => ({ value: option })) }; }
function number(id: string, min: number, max: number, value: number) { return { id, type: "number", min, max, default: value, step: 1 }; }
function bool(id: string, value: boolean) { return { id, type: "boolean", default: value }; }
function providerParameters(params: Record<string, unknown>, allowed: Set<string>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (/^(model|providerModelId|provider|executionProvider|providerMode|images|videos|audios|api[_-]?key|token|secret|password)$/i.test(key)) continue;
    if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) continue;
    const normalized = providerParameterKey(key, allowed);
    if (normalized && allowed.has(normalized)) result[normalized] = value;
  }
  return result;
}
function providerParameterKey(key: string, allowed: Set<string>): string | undefined {
  if (key === "aspectRatio") return allowed.has("aspect_ratio") ? "aspect_ratio" : allowed.has("image_size") ? "image_size" : undefined;
  if (key === "imageSize") return allowed.has("resolution") ? "resolution" : allowed.has("image_resolution") ? "image_resolution" : undefined;
  return key;
}
function kling3FramePrompt(prompt: string): string {
  return prompt
    .replace(/@image(?:\s+|[_-])\d+/gi, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function kieChatParameters(params: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  if (typeof params.reasoning_effort === "string") result.reasoning_effort = params.reasoning_effort;
  if (params.web_search === true) result.tools = [{ type: "function", function: { name: "web_search" } }];
  return result;
}
function mediaInputs(value: unknown): Array<{ path?: string; url?: string }> {
  const result: Array<{ path?: string; url?: string }> = [];
  for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
    if (typeof entry === "string") result.push(/^https?:\/\//.test(entry) ? { url: entry } : { path: entry });
    else {
      const record = objectRecord(entry);
      const url = stringValue(record.url);
      const path = stringValue(record.path) ?? stringValue(record.localPath);
      if (url) result.push({ url }); else if (path) result.push({ path });
    }
  }
  return result;
}
function abortableDelay(ms: number, signal?: AbortSignal) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new KieError("cancelled", "KIE polling cancelled locally.", false)); }, { once: true }); }); }
function objectRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function numberValue(value: unknown): number | undefined { const number = typeof value === "number" ? value : Number(value); return Number.isFinite(number) ? number : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String).filter(Boolean) : []; }
function firstChatText(value: unknown): string | undefined {
  const choices = objectRecord(value).choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  return stringValue(objectRecord(objectRecord(choice).message).content);
}
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function filterDefined(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "" && (!Array.isArray(item) || item.length > 0))); }
function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]") : "unknown error"; }
function safeName(value: string): string { return value.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 96); }
function mimeFromUrl(url: string): string { const extension = extname(new URL(url).pathname).toLowerCase(); return extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".mp4" ? "video/mp4" : extension === ".mp3" ? "audio/mpeg" : "application/octet-stream"; }
function extensionForMime(mime: string): string | undefined { return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/wav": ".wav" } as Record<string, string>)[mime]; }
