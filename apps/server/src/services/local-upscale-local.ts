import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../server-paths";

export type LocalUpscaleRuntimeStatus = {
  service: "Local Upscale";
  state: "stopped" | "starting" | "ready" | "busy" | "error";
  online: boolean;
  configured: boolean;
  activeJobs: number;
  imageJobs?: number;
  videoJobs?: number;
  endpoint: string;
  error?: string;
};

let launchStartedAt = 0;
let launchError: string | undefined;

export function localUpscaleRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.LOCAL_UPSCALE_WORKER_URL || "http://127.0.0.1:8091").trim();
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("Local Upscale lifecycle control is allowed only for a loopback worker.");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Local Upscale worker URL must be a plain local http:// address.");
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Local Upscale worker port is invalid.");
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    port,
    token: (env.LOCAL_UPSCALE_WORKER_TOKEN || "").trim(),
    workerRoot: join(repoRoot, "workers", "local-upscale")
  };
}

export async function readLocalUpscaleStatus(): Promise<LocalUpscaleRuntimeStatus> {
  let config: ReturnType<typeof localUpscaleRuntimeConfig>;
  try {
    config = localUpscaleRuntimeConfig();
  } catch (error) {
    return result("error", false, false, 0, "", errorMessage(error));
  }
  const configured = Boolean(config.token);
  try {
    const health = await fetch(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await health.json().catch(() => ({})) as Record<string, unknown>;
    if (!health.ok || body.service !== "snarkroute-local-upscale-worker") {
      return result("error", true, configured, 0, config.baseUrl, `Port ${config.port} is occupied by another service.`);
    }
    launchStartedAt = 0;
    launchError = undefined;
    if (!configured) return result("ready", true, false, 0, config.baseUrl, "LOCAL_UPSCALE_WORKER_TOKEN is not configured.");

    const runtime = await fetch(`${config.baseUrl}/runtime`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(1200)
    });
    if (runtime.status === 404) return result("ready", true, true, 0, config.baseUrl);
    const state = await runtime.json().catch(() => ({})) as Record<string, unknown>;
    if (!runtime.ok) return result("error", true, true, 0, config.baseUrl, `Runtime status returned ${runtime.status}.`);
    const activeJobs = numberField(state.active_jobs);
    return {
      ...result(activeJobs > 0 ? "busy" : "ready", true, true, activeJobs, config.baseUrl),
      imageJobs: numberField(state.image_jobs),
      videoJobs: numberField(state.video_jobs)
    };
  } catch {
    if (launchError) return result("error", false, configured, 0, config.baseUrl, launchError);
    if (launchStartedAt && Date.now() - launchStartedAt < 60_000) return result("starting", false, configured, 0, config.baseUrl);
    launchStartedAt = 0;
    return result("stopped", false, configured, 0, config.baseUrl);
  }
}

export async function startLocalUpscale(): Promise<LocalUpscaleRuntimeStatus> {
  const config = localUpscaleRuntimeConfig();
  if (!config.token) throw new Error("LOCAL_UPSCALE_WORKER_TOKEN is not configured.");
  const current = await readLocalUpscaleStatus();
  if (current.state === "error") throw new Error(current.error || "Local Upscale is in an error state.");
  if (current.online) return current;
  if (process.platform !== "win32") throw new Error("The installed Local Upscale launcher is currently configured for Windows only.");

  const python = join(config.workerRoot, ".venv", "Scripts", "python.exe");
  if (!existsSync(python)) throw new Error(`Local Upscale Python runtime was not found at ${python}`);
  const logDirectory = join(repoRoot, "apps", "server", "data");
  const logPath = join(logDirectory, "local-upscale-runtime.log");
  mkdirSync(logDirectory, { recursive: true });
  const log = openSync(logPath, "a");

  launchStartedAt = Date.now();
  launchError = undefined;
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(config.port)], {
    cwd: config.workerRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: process.env,
    shell: false
  });
  closeSync(log);
  child.once("error", error => { launchError = `${error.message} See ${logPath}`; });
  child.once("exit", code => {
    if (launchStartedAt) launchError = `Local Upscale exited before it became ready (code ${code ?? "unknown"}). See ${logPath}`;
  });
  child.unref();
  return result("starting", false, true, 0, config.baseUrl);
}

export async function stopLocalUpscale(): Promise<{ ok: true; stopped: boolean; status: LocalUpscaleRuntimeStatus }> {
  const config = localUpscaleRuntimeConfig();
  const current = await readLocalUpscaleStatus();
  if (!current.online) return { ok: true, stopped: false, status: current };
  if (!config.token) throw new Error("Cannot stop Local Upscale safely without LOCAL_UPSCALE_WORKER_TOKEN.");

  const response = await fetch(`${config.baseUrl}/shutdown`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(typeof body.detail === "string" ? body.detail : `Local Upscale shutdown returned ${response.status}.`);
  }
  launchStartedAt = 0;
  launchError = undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const status = await readLocalUpscaleStatus();
    if (!status.online) return { ok: true, stopped: true, status };
  }
  throw new Error("Local Upscale did not stop cleanly.");
}

function result(
  state: LocalUpscaleRuntimeStatus["state"],
  online: boolean,
  configured: boolean,
  activeJobs: number,
  endpoint: string,
  error?: string
): LocalUpscaleRuntimeStatus {
  return { service: "Local Upscale", state, online, configured, activeJobs, endpoint, ...(error ? { error } : {}) };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
