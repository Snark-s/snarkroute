import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../server-paths";
import { localServiceUrl } from "./local-service-endpoints";
import { killProcessTree, launchBackgroundService, processAlive, watchProcessExit } from "./background-process";

/**
 * Qwen-Image-Edit-2511 on stable-diffusion.cpp `sd-server` (workers/qwen-image-edit).
 * sd-server has no auth and no idle unload: it is bound to 127.0.0.1 only, and this
 * service stops the process after QWEN_EDIT_IDLE_SEC without jobs so its ~18 GB of
 * CPU-offloaded weights go back to the OS.
 */
export type QwenEditStatus = {
  service: "Qwen-Image-Edit";
  state: "stopped" | "starting" | "loading" | "ready" | "busy" | "error";
  online: boolean;
  configured: boolean;
  activeJobs: number;
  endpoint: string;
  error?: string;
};

let launchStartedAt = 0;
let launchError: string | undefined;
let activeJobs = 0;
let lastUsedAt = 0;
let idleTimer: NodeJS.Timeout | undefined;

export function qwenEditConfig(env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = localServiceUrl("qwen_edit").replace(/\/$/, "");
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1") throw new Error("Qwen-Image-Edit must be loopback-only.");
  const workerRoot = join(repoRoot, "workers", "qwen-image-edit");
  const models = join(workerRoot, "models");
  return {
    baseUrl,
    port: Number(url.port),
    workerRoot,
    server: join(workerRoot, "bin", "sd-server.exe"),
    pidFile: join(workerRoot, "results", "server.pid"),
    idleSec: Number(env.QWEN_EDIT_IDLE_SEC || 300),
    files: {
      diffusion: join(models, env.QWEN_EDIT_DIFFUSION_FILE || "qwen-image-edit-2511-Q4_K_M.gguf"),
      vae: join(models, "qwen_image_vae.safetensors"),
      llm: join(models, env.QWEN_EDIT_LLM_FILE || "Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf"),
      llmVision: join(models, "Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf")
    }
  };
}

export function qwenEditLogPath(): string {
  return join(repoRoot, "apps", "server", "data", "qwen-edit-runtime.log");
}

export function qwenEditInstalled(config = qwenEditConfig()): boolean {
  return existsSync(config.server) && Object.values(config.files).every(path => existsSync(path));
}

/**
 * Launch args per docs/qwen_image_edit.md (sd.cpp 0518b34). 2511 needs qwen_image_zero_cond_t=true.
 * Model paths are passed RELATIVE to the worker root (the cwd): the repo lives under a Cyrillic
 * path (Y:\Процесс) and a native C++ CLI may not decode non-ASCII argv on Windows.
 */
export function qwenEditServerArgs(config = qwenEditConfig()): string[] {
  const rel = (path: string) => relative(config.workerRoot, path);
  return [
    "--listen-ip", "127.0.0.1", "--listen-port", String(config.port),
    "--diffusion-model", rel(config.files.diffusion),
    "--vae", rel(config.files.vae),
    "--llm", rel(config.files.llm),
    "--llm_vision", rel(config.files.llmVision),
    "--cfg-scale", "2.5", "--sampling-method", "euler", "--flow-shift", "3",
    // --diffusion-fa from the docs is deprecated in 0518b34 ("use --flash-attn off,diffusion=on").
    "--offload-to-cpu", "--flash-attn", "off,diffusion=on",
    "--model-args", "qwen_image_zero_cond_t=true"
  ];
}

export async function readQwenEditStatus(fetchImpl: typeof fetch = fetch): Promise<QwenEditStatus> {
  let config: ReturnType<typeof qwenEditConfig>;
  try { config = qwenEditConfig(); } catch (error) { return status("error", false, false, "", message(error)); }
  const configured = qwenEditInstalled(config);
  try {
    const response = await fetchImpl(`${config.baseUrl}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!response.ok) return status("error", true, configured, config.baseUrl, `Port ${config.port} answered ${response.status}; not sd-server.`);
    launchStartedAt = 0;
    launchError = undefined;
    return status(activeJobs > 0 ? "busy" : "ready", true, configured, config.baseUrl);
  } catch {
    if (launchError) return status("error", false, configured, config.baseUrl, launchError);
    // sd-server preloads the model before listening, so "starting" can last a while.
    if (launchStartedAt && Date.now() - launchStartedAt < 10 * 60_000) return status("loading", false, configured, config.baseUrl);
    launchStartedAt = 0;
    return status("stopped", false, configured, config.baseUrl);
  }
}

export async function startQwenEdit(): Promise<QwenEditStatus> {
  const config = qwenEditConfig();
  if (!qwenEditInstalled(config)) throw new Error("Qwen-Image-Edit is not installed: run workers/qwen-image-edit/download.ps1.");
  const current = await readQwenEditStatus();
  if (current.online || current.state === "loading") return current;
  launchStartedAt = Date.now();
  launchError = undefined;
  const logPath = qwenEditLogPath();
  const launched = await launchBackgroundService({ label: "Qwen-Image-Edit", command: config.server, args: qwenEditServerArgs(config), cwd: config.workerRoot, logPath, env: process.env })
    .catch(error => { launchError = `${message(error)} See ${logPath}`; throw error; });
  if (launched.pid) writeFileSync(config.pidFile, String(launched.pid));
  const exited = () => { if (launchStartedAt) launchError = `sd-server exited before it became ready. See ${logPath}`; };
  if (launched.exitedEarly) exited(); else if (launched.pid) watchProcessExit(launched.pid, exited);
  ensureIdleWatch();
  return status("loading", false, true, config.baseUrl);
}

/** Start if needed and wait until sd-server answers (model preload included). */
export async function ensureQwenEditOnline(timeoutMs = 10 * 60_000): Promise<QwenEditStatus> {
  let current = await readQwenEditStatus();
  if (current.online) return current;
  await startQwenEdit();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(2000);
    current = await readQwenEditStatus();
    if (current.online) return current;
    if (current.state === "error") break;
  }
  throw new Error(current.error || "Qwen-Image-Edit did not come online.");
}

export async function stopQwenEdit(): Promise<{ ok: true; stopped: boolean; status: QwenEditStatus }> {
  const config = qwenEditConfig();
  const pid = readPid(config.pidFile);
  if (!pid || !processAlive(pid)) return { ok: true, stopped: false, status: await readQwenEditStatus() };
  await killProcessTree(pid);
  launchStartedAt = 0;
  launchError = undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const next = await readQwenEditStatus();
    if (!next.online) return { ok: true, stopped: true, status: next };
  }
  throw new Error("Qwen-Image-Edit did not stop cleanly.");
}

/** Providers call these around every job so the idle watch knows when the GPU/RAM can be freed. */
export function markQwenEditJob(delta: 1 | -1): void {
  activeJobs = Math.max(0, activeJobs + delta);
  lastUsedAt = Date.now();
  ensureIdleWatch();
}

function ensureIdleWatch(): void {
  if (idleTimer) return;
  if (!lastUsedAt) lastUsedAt = Date.now();
  idleTimer = setInterval(async () => {
    const { idleSec } = qwenEditConfig();
    if (activeJobs > 0 || idleSec <= 0 || Date.now() - lastUsedAt < idleSec * 1000) return;
    const current = await readQwenEditStatus();
    if (current.state === "loading") return;
    if (current.online) await stopQwenEdit().catch(() => undefined);
    clearInterval(idleTimer);
    idleTimer = undefined;
    lastUsedAt = 0;
  }, 30_000);
  idleTimer.unref?.();
}

function readPid(path: string): number | undefined {
  try { const pid = Number(readFileSync(path, "utf8").trim()); return Number.isInteger(pid) && pid > 0 ? pid : undefined; } catch { return undefined; }
}
function status(state: QwenEditStatus["state"], online: boolean, configured: boolean, endpoint: string, error?: string): QwenEditStatus {
  return { service: "Qwen-Image-Edit", state, online, configured, activeJobs, endpoint, ...(error ? { error } : {}) };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
