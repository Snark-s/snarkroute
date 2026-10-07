import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";

const API_BASE = "https://openapi.tripo3d.ai/v3";
const MISSING_KEY = "TRIPO_API_KEY is not configured. Add a Tripo Developer API key in SnarkRoute settings.";

export type TripoOperation = "retopology" | "segment" | "texture" | "rig";

export interface TripoClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface TripoTaskResult {
  taskId: string;
  status: string;
  progress?: number;
  output: Record<string, unknown>;
  creditsConsumed?: number;
  raw: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Tripo polling cancelled locally."));
    }, { once: true });
  });
}
function mimeFromPath(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".gltf") return "model/gltf+json";
  if (ext === ".fbx") return "application/octet-stream";
  if (ext === ".obj") return "text/plain";
  if (ext === ".stl") return "model/stl";
  return "application/octet-stream";
}

export function createTripoClient(options: TripoClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  function key() {
    const value = options.apiKey ?? process.env.TRIPO_API_KEY ?? process.env.TRIPO_API_TOKEN;
    if (!value?.trim()) throw new Error(MISSING_KEY);
    return value.trim();
  }

  async function jsonRequest(path: string, init: RequestInit = {}) {
    const response = await fetchImpl(API_BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key()}`,
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {})
      }
    });
    const body = record(await response.json().catch(() => ({})));
    const code = numberValue(body.code);
    if (!response.ok || (code !== undefined && code !== 0)) {
      const message = text(body.message) ?? text(body.suggestion) ?? `HTTP ${response.status}`;
      throw new Error(`Tripo request failed (${code ?? response.status}): ${message}`);
    }
    return body;
  }

  return {
    async testConnection() {
      const response = await jsonRequest("/account/balance", { signal: AbortSignal.timeout(10_000) });
      return { ok: true as const, data: record(response.data) };
    },

    async uploadFile(path: string) {
      const bytes = await readFile(path);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeFromPath(path) }), basename(path));
      const response = await jsonRequest("/files", { method: "POST", body: form });
      const token = text(record(response.data).file_token);
      if (!token) throw new Error("Tripo file upload succeeded but returned no file_token.");
      return token;
    },

    async createTask(endpoint: string, body: Record<string, unknown>) {
      const response = await jsonRequest(endpoint, { method: "POST", body: JSON.stringify(body) });
      const taskId = text(record(response.data).task_id);
      if (!taskId) throw new Error("Tripo task creation returned no task_id.");
      return taskId;
    },

    async getTask(taskId: string) {
      const response = await jsonRequest("/tasks/" + encodeURIComponent(taskId));
      return record(response.data);
    },

    async runTask(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal, onProgress?: (progress: number, stage: string) => void | Promise<void>): Promise<TripoTaskResult> {
      const taskId = await this.createTask(endpoint, body);
      const started = Date.now();
      const timeoutMs = options.timeoutMs ?? 15 * 60_000;
      let interval = options.pollIntervalMs ?? 2_000;
      await onProgress?.(0.05, "provider_job:" + taskId);
      while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) throw new Error(`Tripo task ${taskId} cancelled locally.`);
        const data = await this.getTask(taskId);
        const status = String(data.status ?? "").toLowerCase();
        const progressRaw = numberValue(data.progress);
        const progress = progressRaw === undefined ? (status === "queued" ? 0.1 : 0.5) : Math.max(0, Math.min(1, progressRaw > 1 ? progressRaw / 100 : progressRaw));
        await onProgress?.(progress, "provider_job:" + taskId);
        if (status === "success") {
          return {
            taskId,
            status,
            progress,
            output: record(data.output),
            creditsConsumed: numberValue(data.credits_consumed),
            raw: data
          };
        }
        if (status === "failed" || status === "cancelled") {
          throw new Error(`Tripo task ${taskId} ${status}: ${text(data.message) ?? "provider task did not succeed"}`);
        }
        await delay(interval, signal);
        interval = Math.min(8_000, Math.round(interval * 1.3));
      }
      throw new Error(`Tripo task ${taskId} timed out after ${timeoutMs}ms.`);
    }
  };
}

function modelPathFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const r = record(value);
  return text(r.path) ?? text(r.localPath) ?? text(r.filepath);
}

export function buildTripoOperationRequest(operation: TripoOperation, input: string, params: Record<string, unknown>) {
  if (operation === "retopology") {
    const face = Math.round(numberValue(params.face_limit ?? params.faceLimit) ?? 10_000);
    return {
      endpoint: "/mesh/decimate",
      body: {
        input,
        model: text(params.modelVersion) ?? "v2.0",
        face_limit: Math.max(500, Math.min(Boolean(params.quad) ? 10_000 : 20_000, face)),
        quad: Boolean(params.quad ?? false),
        bake: params.bake === undefined ? true : Boolean(params.bake)
      }
    };
  }
  if (operation === "segment") {
    return {
      endpoint: "/mesh/segment",
      body: {
        input,
        model: text(params.modelVersion) ?? "v2.0-20260430",
        segmentation_granularity: text(params.segmentation_granularity ?? params.segmentationGranularity) ?? "balanced"
      }
    };
  }
  if (operation === "texture") {
    const body: Record<string, unknown> = {
      input,
      model: text(params.modelVersion) ?? "v3.0-20250812"
    };
    const prompt = text(params.texture_prompt ?? params.texturePrompt ?? params.prompt);
    if (prompt) body.texture_prompt = prompt;
    return { endpoint: "/models/texture", body };
  }
  const rigType = text(params.rig_type ?? params.rigType) ?? "biped";
  const creature = rigType !== "biped";
  return {
    endpoint: "/animations/rig",
    body: {
      input,
      model: text(params.modelVersion) ?? (creature ? "v2.5-20260210" : "v1.0-20240301"),
      rig_type: rigType,
      spec: text(params.spec ?? params.skeleton_spec ?? params.skeletonSpec) ?? "tripo",
      out_format: "glb"
    }
  };
}

async function downloadModel(url: string, outputDirectory: string, taskId: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Could not download Tripo model (${response.status}).`);
  const dir = join(outputDirectory, "assets");
  await mkdir(dir, { recursive: true });
  const ext = extname(new URL(url).pathname) || ".glb";
  const filename = `tripo-${taskId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80)}${ext}`;
  const path = join(dir, filename);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes);
  return { path, localPath: path, filename, mimeType: "model/gltf-binary", sizeBytes: bytes.byteLength, originalUrl: url };
}

function modelUrl(output: Record<string, unknown>): string | undefined {
  const direct = text(output.model_url) ?? text(output.pbr_model) ?? text(output.base_model);
  if (direct) return direct;
  const urls = output.model_urls;
  if (Array.isArray(urls)) return urls.map(text).find(Boolean);
  return undefined;
}

export function createTripoProcessingNodeRunner(operation: TripoOperation, options: TripoClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const client = createTripoClient(options);
    const modelInputs = Array.isArray(inputs.models) ? inputs.models : [];
    const source = modelPathFrom(params.modelPath ?? params.inputPath ?? params.modelFile ?? inputs.model ?? modelInputs[0] ?? inputs.file ?? inputs.input);
    if (!source) throw new Error(`Tripo ${operation} requires a local 3D model file.`);
    const fileToken = await client.uploadFile(source);
    await context.reportProgress?.(0.03, "upload_complete");
    const request = buildTripoOperationRequest(operation, fileToken, params);
    const task = await client.runTask(request.endpoint, request.body, context.signal, context.reportProgress);
    const url = modelUrl(task.output);
    if (!url) throw new Error(`Tripo ${operation} succeeded but returned no model_url.`);
    const asset = await downloadModel(url, context.outputDirectory, task.taskId, options.fetchImpl ?? fetch);
    const partNames = Array.isArray(task.output.part_names) ? task.output.part_names.map(String) : [];
    const providerUsage: ProviderUsageEvent = {
      provider: "tripo",
      model: String(params.providerModelId ?? params.model ?? operation),
      nodeId: node.id,
      nodeType: node.type,
      externalId: task.taskId,
      status: "succeeded",
      actualCost: null,
      actualCostCurrency: null,
      metrics: task.creditsConsumed === undefined ? {} : { tripoCreditsConsumed: task.creditsConsumed },
      pricingSource: "provider_actual_credits"
    };
    return {
      output: {
        model: asset,
        models: [asset],
        partNames,
        taskId: task.taskId,
        creditsConsumed: task.creditsConsumed,
        provider: "tripo",
        operation
      },
      logs: [`Tripo ${operation} task ${task.taskId} completed; downloaded ${asset.filename}.`],
      provenance: { provider: "tripo", operation, taskId: task.taskId },
      providerUsage
    };
  };
}

export function createTripoRetopologyNodeRunner(options: TripoClientOptions = {}) {
  return createTripoProcessingNodeRunner("retopology", options);
}
export function createTripoSegmentNodeRunner(options: TripoClientOptions = {}) {
  return createTripoProcessingNodeRunner("segment", options);
}
export function createTripoTextureNodeRunner(options: TripoClientOptions = {}) {
  return createTripoProcessingNodeRunner("texture", options);
}
export function createTripoRigNodeRunner(options: TripoClientOptions = {}) {
  return createTripoProcessingNodeRunner("rig", options);
}
