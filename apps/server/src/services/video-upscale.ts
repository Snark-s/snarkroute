import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repoRoot } from "../server-paths";
import type { NodeRunner } from "@snarkroute/executor";
import { H3QueueBlockedError, type H3QueueItem, type H3RenderResult } from "./h3-queue";

const workerRoot = join(repoRoot, "workers", "local-upscale");
export const VIMEO_MODEL = "openmodeldb/vimeoscale-unet-x2";
export const VIDEO_UPSCALE_PROFILE = { model: VIMEO_MODEL, scale: 2, context: 3, chunk_size: 3, overlap_frames: 1, device: "cuda", audio_handling: "copy", output_codec: "libx264", output_container: "mp4", preset: "medium", crf: 18, gop: 48 } as const;
export type VideoUpscaleSettings = Record<string, unknown> & { model: string; scale: number; context: number; chunk_size: number; overlap_frames: number; device: string; audio_handling: string; crf: number; preset: string; gop: number; delivery?: [number, number] };
type RegistryModel = { id: string; display_name: string; native_scale: number; context_frames: number; recommended_chunk_size: number; recommended_overlap_frames: number; license: string; commercial_use: boolean | null; spatial_tiling_supported?: boolean; recommended_tile_size?: number; resource: { filename: string; sha256: string }; [key: string]: unknown };

function models(): RegistryModel[] {
  const temporal = JSON.parse(readFileSync(join(workerRoot, "video-model-registry.json"), "utf8")).models as RegistryModel[];
  const images = JSON.parse(readFileSync(join(workerRoot, "model-registry.json"), "utf8")).models as Array<RegistryModel & { scale_factor: number }>;
  return [...temporal, ...images.map(m => ({ ...m, id: `framewise/${m.id}`, native_scale: m.scale_factor, context_frames: 1, recommended_chunk_size: 1, recommended_overlap_frames: 0, commercial_use: null }))];
}

export async function videoUpscaleCatalog() {
  return { profile: VIDEO_UPSCALE_PROFILE, profileName: "VimeoScale 2× — Conservative Video", models: models().map(m => ({
    ...m, group: m.id === VIMEO_MODEL ? "Production" : "Experimental",
    verification: m.id === VIMEO_MODEL ? "Verified · H3 Max / CUDA / 2× tested" : m.id === "framewise/4x-purephoto-span" ? "Tested · manual" : "Unverified",
    display_name: m.id === VIMEO_MODEL ? "VimeoScale 2× — Conservative Video" : m.id === "framewise/4x-purephoto-span" ? "PurePhoto SPAN 4× — Framewise Photo" : m.id.includes("gameup") ? "GameUp TSCUNet 2× — Temporal / Noncommercial" : m.display_name,
    weights_installed: existsSync(join(workerRoot,"models",m.resource.filename))
  })), resourcePolicy: { minFreeVramMiB: 8192, minAvailableRamMiB: 4096, cpuThreads: 2, oneJobAtATime: true },
  runtimeInstalled: existsSync(join(workerRoot,".venv","Scripts","python.exe")),
  description: "Temporal 2× upscale optimized for preserving motion and appearance. Best for clean generated/video sources where conservative enlargement is preferred over aggressive detail invention." };
}

export function normalizeVideoUpscale(input: Record<string, unknown> = {}): VideoUpscaleSettings {
  const model = models().find(m => m.id === (input.model ?? VIMEO_MODEL));
  if (!model) throw new Error("Unknown Video Upscale model.");
  const settings = { ...VIDEO_UPSCALE_PROFILE, ...input, model: model.id, scale: model.native_scale, context: model.context_frames,
    chunk_size: input.chunk_size ?? (model.id === VIMEO_MODEL ? 3 : model.recommended_chunk_size),
    overlap_frames: input.overlap_frames ?? model.recommended_overlap_frames } as unknown as VideoUpscaleSettings;
  if (settings.device !== "cuda") throw new Error("Video Upscale requires CUDA; CPU fallback is disabled.");
  if (input.scale !== undefined && input.scale !== model.native_scale) throw new Error("Model scale is fixed; choose a downstream delivery size instead.");
  for (const [key,min,max] of [["crf",0,51],["chunk_size",1,120],["overlap_frames",0,16],["gop",1,600]] as const) {
    const value = settings[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid Video Upscale ${key}.`);
  }
  if (settings.overlap_frames >= settings.chunk_size || settings.overlap_frames < Math.floor(model.context_frames / 2) && model.inference_mode === "center-frame") throw new Error("Invalid temporal overlap for the selected model.");
  if (model.context_frames === 1 && settings.overlap_frames !== 0) throw new Error("Framewise models require zero temporal overlap.");
  if (!["copy","drop","aac"].includes(settings.audio_handling)) throw new Error("Invalid audio handling.");
  if (!["fast","medium","slow"].includes(settings.preset)) throw new Error("Invalid encoder preset.");
  if (settings.output_codec !== "libx264" || settings.output_container !== "mp4") throw new Error("Video Upscale requires H.264 / MP4.");
  if (settings.delivery !== undefined && (!Array.isArray(settings.delivery) || settings.delivery.length !== 2 || settings.delivery.some(n => !Number.isInteger(n) || n < 2 || n > 8192 || n % 2))) throw new Error("Delivery canvas must have two even dimensions between 2 and 8192.");
  // Only supported worker fields are serialized, never H3 generation parameters.
  return Object.fromEntries(Object.entries(settings).filter(([key]) => [...Object.keys(VIDEO_UPSCALE_PROFILE),"delivery"].includes(key))) as VideoUpscaleSettings;
}

const active = new Map<string, string>();
export async function cancelVideoUpscale(item: H3QueueItem) {
  const session = active.get(item.id);
  if (session) await writeFile(join(session,"cancel.flag"),"cancel");
}

export async function renderVideoUpscale(item: H3QueueItem, resultsDirectory: string, onProgress: (progress: number, stage?: string) => Promise<void>, onJobCreated?: (id: string) => Promise<void>): Promise<H3RenderResult> {
  const source = item.assets.find(a => a.slot === "sourceVideo" && a.kind === "video");
  if (!source) throw new Error("Video Upscale requires one source video.");
  const python = join(workerRoot,".venv","Scripts","python.exe");
  if (!existsSync(python)) throw new H3QueueBlockedError("Blocked by resources: local upscale Python runtime is not installed.");
  const session = join(resultsDirectory,item.id,`upscale-${Date.now()}`);
  await mkdir(session,{ recursive: true });
  const requestPath = join(session,"request.json");
  const settings = normalizeVideoUpscale(item.videoUpscale);
  await writeFile(requestPath,JSON.stringify({ source: resolve(source.path), mime: source.mimeType, session: resolve(session), settings }));
  active.set(item.id,session);
  try {
    await onJobCreated?.(`upscale-${item.id}`); // cancellation is available during startup/preflight
    const result = await new Promise<Record<string, any>>((resolve,reject) => {
      const child = spawn(python,["scripts/run_video_production.py","--request",requestPath],{ cwd: workerRoot, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }, stdio: ["ignore","pipe","pipe"] });
      let pending = "", diagnostics = "", final: Record<string, any> | undefined;
      let updates = Promise.resolve();
      let reportedJobId = "";
      const timer = setTimeout(() => { void cancelVideoUpscale(item); }, 7350_000);
      child.stdout.on("data",chunk => {
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0,newline); pending = pending.slice(newline+1);
          try {
            const event = JSON.parse(line);
            if (event.result) final = event.result;
            else updates = updates.then(async () => { if (event.workerJobId && event.workerJobId !== reportedJobId) { reportedJobId = event.workerJobId; await onJobCreated?.(event.workerJobId); } await onProgress(event.progress ?? 0,event.stage); });
          } catch { diagnostics = (diagnostics+line).slice(-4000); }
        }
      });
      child.stderr.on("data",chunk => { diagnostics = (diagnostics+chunk.toString()).slice(-4000); });
      child.once("error",error => { clearTimeout(timer); reject(error); });
      child.once("close",code => {
        clearTimeout(timer);
        void updates.then(() => final ? resolve(final) : reject(new Error(`Video Upscale supervisor exited ${code}: ${diagnostics}`)),reject);
      });
    });
    if (result.status !== "SUCCEEDED") {
      const message = `${result.error ?? result.status}${result.shutdown ? ` · Worker lifecycle: ${result.shutdown.classification}` : ""} · Diagnostics: ${join(session,"diagnostics.json")}`;
      if (result.status === "BLOCKED") throw new H3QueueBlockedError(message);
      throw new Error(message);
    }
    return { workerJobId: result.worker_job_id, resultPaths: [result.output], metadata: { provider: "local", model: settings.model, latencyMs: { total: result.total_wall_seconds*1000 }, provenance: { ...result.worker_output?.provenance, source_asset: source.path, source_filename: source.filename, profile: settings.model === VIMEO_MODEL ? "VimeoScale 2× — Conservative Video" : "Experimental / Manual", shutdown: result.shutdown, software_versions: result.software_versions, diagnostics: join(session,"diagnostics.json") } } };
  } finally { active.delete(item.id); }
}

export function createProductionVideoUpscaleNodeRunner(renderer = renderVideoUpscale): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const input = params.video ?? params.videos ?? inputs.video ?? inputs.videos;
    if (Array.isArray(input) && input.length !== 1) throw new Error("Video Upscale requires exactly one source video.");
    const value = Array.isArray(input) ? input[0] : input;
    const source = typeof value === "string" ? { path: value } : value as Record<string, unknown> | undefined;
    const path = source?.localPath ?? source?.path;
    if (typeof path !== "string" || !path) throw new Error("Video Upscale requires a local video asset.");
    const settings = normalizeVideoUpscale(params);
    const item = { id: `vup-${randomUUID()}`, operation: "video_upscale", videoUpscale: settings, assets: [{ slot: "sourceVideo", kind: "video", path, filename: String(source?.filename ?? path.split(/[\\/]/).pop()), mimeType: String(source?.mimeType ?? (path.toLowerCase().endsWith(".mov") ? "video/quicktime" : path.toLowerCase().endsWith(".webm") ? "video/webm" : path.toLowerCase().endsWith(".mkv") ? "video/x-matroska" : "video/mp4")) }] } as H3QueueItem;
    const cancel = () => { void cancelVideoUpscale(item); };
    context.signal?.addEventListener("abort",cancel,{ once: true });
    try {
      if (context.signal?.aborted) throw new Error("Video Upscale cancelled.");
      const result = await renderer(item,context.outputDirectory,async (progress,stage) => { await context.reportProgress?.(progress,stage); },async () => { if (context.signal?.aborted) await cancelVideoUpscale(item); });
      const provenance = result.metadata?.provenance;
      const resolution = provenance?.delivery_resolution as number[] | undefined;
      const video = { path: result.resultPaths[0], localPath: result.resultPaths[0], mimeType: "video/mp4", width: resolution?.[0], height: resolution?.[1], fps: provenance?.fps, frameCount: provenance?.frames };
      return { output: { video, videos: [video], model: settings.model, provider: "local_video_upscale", providerJobId: result.workerJobId, telemetry: provenance, estimatedCost: 0, actualCost: 0 }, provenance: { provider: "local_video_upscale", model: settings.model, ...provenance }, providerUsage: { provider: "local_video_upscale", model: settings.model, nodeId: node.id, nodeType: node.type, externalId: result.workerJobId, status: "succeeded", estimatedCost: 0, actualCost: 0, pricingHint: "local-inference-zero-api-cost" } };
    } finally { context.signal?.removeEventListener("abort",cancel); }
  };
}
