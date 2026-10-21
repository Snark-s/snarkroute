import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { modelGatewayJobService, type GenerationJob, type GenerationJobRequest } from "../model-gateway-jobs/service";

/**
 * Image tools for a smart subscription model (Codex, Claude) that art-directs a
 * local generator: submit -> wait -> look at the preview -> fix -> repeat.
 * Everything goes through the Model Gateway, never straight to a worker.
 */
type JobService = Pick<typeof modelGatewayJobService, "create" | "get" | "cancel">;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const PREVIEW_MAX_SIDE = 1024;
const RAW_PREVIEW_LIMIT = 4 * 1024 * 1024;

export const LOCAL_IMAGE_PROVIDERS = {
  flux3_native: { modelId: "flux3_native:flux-3-image-klein", providerModelId: "flux-3-image-klein", maxReferences: 10 }
} as const;

export const IMAGE_TOOL_INSTRUCTIONS = " Image tools: image_generate submits a local generation/edit job through the Model Gateway (provider flux3_native, zero API cost, heavy GPU). Before starting, check local_runtime_admission(runtimeId=\"flux3\") and surface warnings: the owner's interactive GPU work (TouchDesigner, Mixar) has priority. Always look at the returned preview and compare it with the brief before reporting success; iterate with a corrected prompt or seed when it misses. Use image_view to inspect any local image (sources, references, earlier versions).";

const dim = z.number().int().min(256).max(2048).refine(v => v % 16 === 0, "must be a multiple of 16");

export function registerImageTools(server: McpServer, jobs: JobService = modelGatewayJobService, sleep = defaultSleep): void {
  server.registerTool("image_generate", {
    description: "Generate or edit an image with the local FLUX.3 Klein model through SnarkRoute's Model Gateway. Pass references (absolute local paths) to edit or guide by up to 10 images. Waits up to waitSeconds and returns the job plus a preview image when done; otherwise poll with image_job.",
    inputSchema: {
      prompt: z.string().min(1).max(20000),
      references: z.array(z.string().min(1)).max(10).optional(),
      width: dim.optional(),
      height: dim.optional(),
      steps: z.number().int().min(1).max(50).optional(),
      seed: z.number().int().min(0).max(2147483647).optional(),
      provider: z.enum(["flux3_native"]).optional(),
      waitSeconds: z.number().int().min(0).max(600).optional()
    }
  }, async input => {
    try {
      const provider = LOCAL_IMAGE_PROVIDERS[input.provider ?? "flux3_native"];
      const references = await validatedImagePaths(input.references ?? []);
      const request: GenerationJobRequest = {
        capability: references.length ? "image.edit" : "image.generate",
        nodeType: "ai.image.generate",
        outputMediaType: "image",
        modelId: provider.modelId,
        providerModelId: provider.providerModelId,
        provider: input.provider ?? "flux3_native",
        prompt: input.prompt,
        parameters: { width: input.width ?? 512, height: input.height ?? 512, steps: input.steps ?? 16, seed: input.seed ?? Math.floor(Math.random() * 2147483647) },
        inputs: references.map((path, index) => ({ kind: "image" as const, role: "reference", index, assetId: `local:${basename(path)}`, path })),
        hostType: "api",
        sourceContext: { client: "mcp", tool: "image_generate" }
      };
      const job = await jobs.create(request);
      return await jobResult(jobs, job.id, input.waitSeconds ?? 240, sleep);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("image_job", {
    description: "Read a Model Gateway image job (from image_generate). Waits up to waitSeconds for completion and returns the preview image when completed.",
    inputSchema: { jobId: z.string().regex(/^gen_[a-f0-9-]+$/i), waitSeconds: z.number().int().min(0).max(600).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try { return await jobResult(jobs, input.jobId, input.waitSeconds ?? 0, sleep); } catch (error) { return failure(error); }
  });

  server.registerTool("image_cancel", {
    description: "Cancel a running image job.",
    inputSchema: { jobId: z.string().regex(/^gen_[a-f0-9-]+$/i) }
  }, async input => {
    try {
      const job = await jobs.cancel(input.jobId);
      return job ? text({ ok: true, job: summary(job) }) : failure(new Error("Unknown job."));
    } catch (error) { return failure(error); }
  });

  server.registerTool("image_view", {
    description: "Look at a local image (PNG/JPEG/WEBP, absolute path): returns it as an image downscaled to at most 1024 px so you can judge composition, style and errors.",
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try {
      const [path] = await validatedImagePaths([input.path]);
      const preview = await previewImage(path);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, path, ...preview.info }) }, preview.content] };
    } catch (error) { return failure(error); }
  });
}

async function jobResult(jobs: JobService, id: string, waitSeconds: number, sleep: (ms: number) => Promise<void>) {
  const deadline = Date.now() + waitSeconds * 1000;
  let job = await jobs.get(id);
  while (job && !TERMINAL.has(job.status) && Date.now() < deadline) {
    await sleep(2000);
    job = await jobs.get(id);
  }
  if (!job) return failure(new Error("Unknown job."));
  const body = { ok: job.status !== "failed", job: summary(job), ...(TERMINAL.has(job.status) ? {} : { hint: "Still running; call image_job with waitSeconds to keep waiting." }) };
  if (job.status !== "completed" || !job.result?.path) return { ...text(body), ...(job.status === "failed" ? { isError: true } : {}) };
  const preview = await previewImage(job.result.path).catch(() => undefined);
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }, ...(preview ? [preview.content] : [])] };
}

function summary(job: GenerationJob) {
  return {
    id: job.id, status: job.status, progress: job.progress, provider: job.request.provider,
    prompt: job.request.prompt, parameters: job.request.parameters,
    references: (job.request.inputs ?? []).map(input => input.path),
    resultPath: job.result?.path, outputs: job.outputs?.map(output => ({ path: output.path, width: output.width, height: output.height })),
    cost: job.costs?.providerCost ?? null, error: job.error,
    startedAt: job.startedAt, completedAt: job.completedAt
  };
}

export async function validatedImagePaths(paths: string[]): Promise<string[]> {
  return await Promise.all(paths.map(async raw => {
    if (!isAbsolute(raw)) throw new Error(`Image path must be absolute: ${raw}`);
    const path = resolve(raw);
    if (!IMAGE_EXT.has(extname(path).toLowerCase())) throw new Error(`Unsupported image type: ${basename(path)}`);
    if (!(await stat(path)).isFile()) throw new Error(`Not a file: ${path}`);
    return path;
  }));
}

async function previewImage(path: string) {
  const sharp = await import("sharp").then(module => (module as unknown as { default: typeof import("sharp") }).default ?? module).catch(() => null) as null | ((input: string) => import("sharp").Sharp);
  if (sharp) {
    const image = sharp(path);
    const meta = await image.metadata();
    const data = await image.rotate().resize({ width: PREVIEW_MAX_SIDE, height: PREVIEW_MAX_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { info: { width: meta.width, height: meta.height, previewMaxSide: PREVIEW_MAX_SIDE }, content: { type: "image" as const, data: data.toString("base64"), mimeType: "image/jpeg" } };
  }
  const bytes = await readFile(path);
  if (bytes.length > RAW_PREVIEW_LIMIT) throw new Error("Image is too large to preview without sharp.");
  const ext = extname(path).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { info: { bytes: bytes.length }, content: { type: "image" as const, data: bytes.toString("base64"), mimeType } };
}

function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
function failure(error: unknown) { return { ...text({ ok: false, error: error instanceof Error ? error.message : String(error) }), isError: true }; }
function defaultSleep(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }
