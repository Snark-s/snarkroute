import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeRunner } from "@snarkroute/executor";
import { referencePaths, validateInteger } from "./flux3-native";

export const QWEN_EDIT_PROVIDER = "qwen_edit_local";
export const QWEN_EDIT_MODEL_ID = "qwen-image-edit-2511";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function qwenEditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QWEN_EDIT_ENABLED === "1";
}

/** Fit the first reference into <= maxSide px, multiples of 16 (keeps aspect ratio). */
export function fitSize(width: number, height: number, maxSide = 1024): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const snap = (value: number) => Math.max(256, Math.round((value * scale) / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

type Deps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; baseUrl?: string; skipRuntime?: boolean };

export async function runQwenEditJob(
  payload: { prompt: string; refs: string[]; width: number; height: number; steps: number; seed: number; cfg: number },
  output: string,
  signal?: AbortSignal,
  deps: Deps = {}
): Promise<{ width: number; height: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let baseUrl = deps.baseUrl;
  let mark: ((delta: 1 | -1) => void) | undefined;
  if (!deps.skipRuntime) {
    const { assertLocalRuntimeAdmission } = await import("../services/local-runtime-supervisor");
    const runtime = await import("../services/qwen-edit-local");
    await assertLocalRuntimeAdmission("qwen_edit", QWEN_EDIT_MODEL_ID);
    await runtime.ensureQwenEditOnline();
    baseUrl = runtime.qwenEditConfig().baseUrl;
    mark = runtime.markQwenEditJob;
  }
  if (!baseUrl) throw new Error("Qwen-Image-Edit endpoint is not configured.");
  mark?.(1);
  try {
    const refImages = await Promise.all(payload.refs.map(async path => (await readFile(path)).toString("base64")));
    const submit = await fetchImpl(`${baseUrl}/sdcpp/v1/img_gen`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal, redirect: "error",
      body: JSON.stringify({
        prompt: payload.prompt, negative_prompt: "", width: payload.width, height: payload.height, seed: payload.seed,
        ref_images: refImages, output_format: "png",
        sample_params: { sample_steps: payload.steps, guidance: { txt_cfg: payload.cfg } }
      })
    });
    const created = await submit.json().catch(() => ({})) as { id?: string; poll_url?: string; error?: unknown };
    if (!submit.ok || !created.id) throw new Error(`Qwen-Image-Edit rejected the job (${submit.status}): ${JSON.stringify(created.error ?? created).slice(0, 400)}`);
    const pollUrl = `${baseUrl}${created.poll_url ?? `/sdcpp/v1/jobs/${created.id}`}`;
    const onAbort = () => { void fetchImpl(`${baseUrl}/sdcpp/v1/jobs/${created.id}/cancel`, { method: "POST" }).catch(() => undefined); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw new Error("Qwen-Image-Edit job cancelled.");
        const job = await (await fetchImpl(pollUrl, { redirect: "error" })).json() as { status?: string; error?: unknown; result?: { images?: Array<{ b64_json?: string }> } };
        if (job.status && TERMINAL.has(job.status)) {
          const image = job.result?.images?.[0]?.b64_json;
          if (job.status !== "completed" || !image) throw new Error(`Qwen-Image-Edit job ${job.status}: ${JSON.stringify(job.error ?? "no image").slice(0, 600)}`);
          await writeFile(output, Buffer.from(image, "base64"));
          return { width: payload.width, height: payload.height };
        }
        await sleep(1500);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    mark?.(-1);
  }
}

async function imageSize(path: string): Promise<{ width: number; height: number } | undefined> {
  const sharp = await import("sharp").then(module => (module as unknown as { default: (input: string) => { metadata(): Promise<{ width?: number; height?: number }> } }).default).catch(() => null);
  if (!sharp) return undefined;
  const meta = await sharp(path).metadata().catch(() => ({} as { width?: number; height?: number }));
  return meta.width && meta.height ? { width: meta.width, height: meta.height } : undefined;
}

export function createQwenEditNodeRunner(options: { enabled?: boolean; deps?: Deps } = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    if (!(options.enabled ?? qwenEditEnabled())) throw new Error("Qwen-Image-Edit is not enabled. Install it (workers/qwen-image-edit) and set QWEN_EDIT_ENABLED=1.");
    const prompt = String(params.prompt ?? inputs.prompt ?? "").trim();
    if (!prompt || prompt.length > 20000) throw new Error("Qwen-Image-Edit requires an edit instruction (max 20000 characters).");
    const refs = referencePaths(params.images ?? params.image ?? inputs.images ?? inputs.image);
    if (!refs.length) throw new Error("Qwen-Image-Edit needs at least one source image to edit.");
    for (const path of refs) { if (!(await stat(path)).isFile()) throw new Error("Qwen-Image-Edit source is not a file."); }
    const source = await imageSize(refs[0]);
    const fitted = source ? fitSize(source.width, source.height) : { width: 1024, height: 1024 };
    const width = params.width === undefined ? fitted.width : validateInteger(params.width, 1024, 256, 2048);
    const height = params.height === undefined ? fitted.height : validateInteger(params.height, 1024, 256, 2048);
    const payload = {
      prompt, refs, width: width - (width % 16), height: height - (height % 16),
      steps: validateInteger(params.steps, 20, 1, 60),
      seed: validateInteger(params.seed, 0, 0, 2147483647),
      cfg: typeof params.cfg === "number" && params.cfg > 0 && params.cfg <= 10 ? params.cfg : 2.5
    };
    const outputDir = join(context.outputDirectory, "assets");
    await mkdir(outputDir, { recursive: true });
    const output = join(outputDir, `${node.id}-qwen-edit-${randomUUID()}.png`);
    const result = await runQwenEditJob(payload, output, context.signal, options.deps);
    const bytes = (await stat(output)).size;
    const descriptor = { path: output, localPath: output, filename: output.split(/[\\/]/).at(-1), mimeType: "image/png", width: result.width, height: result.height, sizeBytes: bytes };
    return {
      output: { image: descriptor, images: [descriptor], provider: QWEN_EDIT_PROVIDER, model: QWEN_EDIT_MODEL_ID, estimatedCost: 0, actualCost: 0 },
      provenance: { provider: QWEN_EDIT_PROVIDER, model: QWEN_EDIT_MODEL_ID, seed: payload.seed, steps: payload.steps, cfg: payload.cfg, width: result.width, height: result.height, references: refs.length },
      providerUsage: { provider: QWEN_EDIT_PROVIDER, model: QWEN_EDIT_MODEL_ID, nodeId: node.id, nodeType: node.type, status: "succeeded", estimatedCost: 0, actualCost: 0, pricingHint: "local-inference-zero-api-cost" }
    };
  };
}
