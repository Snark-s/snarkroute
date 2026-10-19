import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeRunner } from "@snarkroute/executor";

export const FLUX3_NATIVE_MODEL_ID = "flux-3-image-klein";
export const FLUX3_NATIVE_PROVIDER = "flux3_native";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
export const FLUX3_NATIVE_SCRIPT = join(ROOT, "workers", "flux3-native", "infer.py");

export function nativeFlux3Configured(env: NodeJS.ProcessEnv = process.env): boolean {
  // Explicit opt-in prevents Auto routing to a model that has not been installed.
  return env.FLUX3_NATIVE_ENABLED === "1";
}

export function validateDimension(value: unknown, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 256 || n > 2048 || n % 16 !== 0) throw new Error("FLUX.3 dimension must be a multiple of 16 between 256 and 2048.");
  return n;
}
export function validateInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid FLUX.3 numeric parameter: ${String(value)}`);
  return n;
}
export function referencePaths(value: unknown): string[] {
  const values = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  if (values.length > 10) throw new Error("FLUX.3 supports up to ten reference images.");
  return values.map(ref => {
    const record = ref && typeof ref === "object" ? ref as Record<string, unknown> : {};
    const path = typeof ref === "string" ? ref : typeof record.localPath === "string" ? record.localPath : record.path;
    if (typeof path !== "string" || !path.trim() || ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase())) {
      throw new Error("Each reference must be a PNG, JPEG, or WEBP local asset.");
    }
    return resolve(path);
  });
}

export async function runNativeFlux3Process(
  payload: Record<string, unknown>,
  options: { pythonPath: string; scriptPath: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<{ ok: true; output: string; width: number; height: number }> {
  await stat(options.scriptPath);
  return await new Promise((resolveJob, rejectJob) => {
    const child = spawnProcess(options.pythonPath, [options.scriptPath], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false,
      env: { ...process.env, PYTHONUNBUFFERED: "1" }
    });
    let stderr = "";
    let stdout = "";
    let settled = false;
    const finish = (error?: Error, data?: { ok: true; output: string; width: number; height: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) rejectJob(error);
      else if (data) resolveJob(data);
      else rejectJob(new Error("No FLUX.3 result returned."));
    };
    const abort = () => { child.kill(); finish(new Error("FLUX.3 generation cancelled.")); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("FLUX.3 generation timed out.")); }, options.timeoutMs ?? 3600000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-10000); });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-10000); });
    child.on("error", error => finish(error));
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) {
        const line = stderr.trim().split(/\r?\n/).at(-1);
        let message = line || "FLUX.3 process exited unexpectedly.";
        try { const parsed = JSON.parse(message) as { message?: string }; message = parsed.message || message; } catch {}
        return finish(new Error(`FLUX.3 worker failed (exit ${code}): ${message.slice(0, 800)}`));
      }
      try {
        const data = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || "{}") as { ok?: boolean; output?: string; width?: number; height?: number };
        if (data.ok !== true || typeof data.output !== "string" || data.output !== payload.output ||
            !Number.isInteger(data.width) || !Number.isInteger(data.height)) {
          throw new Error("Invalid native FLUX.3 worker result.");
        }
        finish(undefined, data as { ok: true; output: string; width: number; height: number });
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid worker JSON")); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
    if (options.signal?.aborted) abort();
  });
}

export function createNativeFlux3NodeRunner(options: { pythonPath?: string; scriptPath?: string; enabled?: boolean } = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    if (!(options.enabled ?? nativeFlux3Configured())) {
      throw new Error("FLUX.3 native is not installed. Configure its dedicated Python environment and enable FLUX3_NATIVE_ENABLED=1.");
    }
    const prompt = String(params.prompt ?? inputs.prompt ?? "").trim();
    if (!prompt || prompt.length > 30000) throw new Error("FLUX.3 requires a prompt (max 30000 characters).");
    const refs = referencePaths(params.images ?? params.image ?? inputs.images ?? inputs.image);
    for (const path of refs) { if (!(await stat(path)).isFile()) throw new Error("FLUX.3 reference is not a file."); }
    const outputDir = join(context.outputDirectory, "assets");
    await mkdir(outputDir, { recursive: true });
    const output = join(outputDir, `${node.id}-flux3-${randomUUID()}.png`);
    const payload = {
      prompt,
      images: refs,
      output,
      seed: validateInteger(params.seed, 0, 0, 2147483647),
      width: validateDimension(params.width, 512),
      height: validateDimension(params.height, 512),
      steps: validateInteger(params.steps, 16, 1, 50)
    };
    const pythonPath = options.pythonPath ?? join(ROOT, "workers", "flux3-native", ".venv", "Scripts", "python.exe");
    const result = await runNativeFlux3Process(payload, { pythonPath, scriptPath: options.scriptPath ?? FLUX3_NATIVE_SCRIPT, signal: context.signal });
    const bytes = (await stat(result.output)).size;
    const descriptor = { path: result.output, localPath: result.output, filename: result.output.split(/[\\/]/).at(-1), mimeType: "image/png", width: result.width, height: result.height, sizeBytes: bytes };
    return {
      output: { image: descriptor, images: [descriptor], provider: FLUX3_NATIVE_PROVIDER, model: FLUX3_NATIVE_MODEL_ID, estimatedCost: 0, actualCost: 0 },
      provenance: { provider: FLUX3_NATIVE_PROVIDER, model: FLUX3_NATIVE_MODEL_ID, seed: payload.seed, steps: payload.steps, width: result.width, height: result.height, references: refs.length },
      providerUsage: { provider: FLUX3_NATIVE_PROVIDER, model: FLUX3_NATIVE_MODEL_ID, nodeId: node.id, nodeType: node.type, status: "succeeded", estimatedCost: 0, actualCost: 0, pricingHint: "local-inference-zero-api-cost" }
    };
  };
}
