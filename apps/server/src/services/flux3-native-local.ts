import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../server-paths";
import { localServiceUrl } from "./local-service-endpoints";
import { launchBackgroundService, PYTHON_LOG_ENV, watchProcessExit } from "./background-process";

/** Persistent FLUX.3 Klein worker (workers/flux3-native/worker.py). Mirrors local-upscale-local.ts. */
export const FLUX3_WORKER_SERVICE = "snarkroute-flux3-worker";

export type Flux3WorkerStatus = {
  service: "FLUX.3 Klein";
  state: "stopped" | "starting" | "loading" | "ready" | "busy" | "error";
  online: boolean;
  configured: boolean;
  loaded: boolean;
  activeJobs: number;
  endpoint: string;
  lastDurationSec?: number | null;
  error?: string;
};

let launchStartedAt = 0;
let launchError: string | undefined;

export function flux3WorkerLogPath(): string {
  return join(repoRoot, "apps", "server", "data", "flux3-native-runtime.log");
}

export function flux3WorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = localServiceUrl("flux3_native").replace(/\/$/, "");
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1") throw new Error("FLUX.3 worker must be loopback-only.");
  return {
    baseUrl,
    port: Number(url.port),
    token: (env.FLUX3_WORKER_TOKEN || "").trim(),
    idleUnloadSec: (env.FLUX3_IDLE_UNLOAD_SEC || "300").trim(),
    workerRoot: join(repoRoot, "workers", "flux3-native")
  };
}

export async function readFlux3WorkerStatus(options: { fetchImpl?: typeof fetch } = {}): Promise<Flux3WorkerStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let config: ReturnType<typeof flux3WorkerConfig>;
  try { config = flux3WorkerConfig(); } catch (error) { return status("error", false, false, "", errorMessage(error)); }
  const configured = Boolean(config.token);
  try {
    const health = await fetchImpl(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(1000), redirect: "error" });
    const body = await health.json().catch(() => ({})) as Record<string, unknown>;
    if (health.status !== 200 || body.service !== FLUX3_WORKER_SERVICE) {
      return status("error", true, configured, config.baseUrl, `Port ${config.port} is occupied by another service.`);
    }
    launchStartedAt = 0;
    launchError = undefined;
    if (!configured) return status("ready", true, false, config.baseUrl, "FLUX3_WORKER_TOKEN is not configured.");
    const runtime = await fetchImpl(`${config.baseUrl}/runtime`, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1500), redirect: "error"
    });
    const state = await runtime.json().catch(() => ({})) as Record<string, unknown>;
    if (!runtime.ok) return status("error", true, true, config.baseUrl, `Runtime status returned ${runtime.status}.`);
    const activeJobs = typeof state.active_jobs === "number" ? state.active_jobs : 0;
    const loading = state.loading === true;
    return {
      ...status(loading ? "loading" : activeJobs > 0 ? "busy" : "ready", true, true, config.baseUrl),
      loaded: state.loaded === true,
      activeJobs,
      lastDurationSec: typeof state.last_duration_sec === "number" ? state.last_duration_sec : null,
      ...(typeof state.last_error === "string" ? { error: state.last_error } : {})
    };
  } catch {
    if (launchError) return status("error", false, configured, config.baseUrl, launchError);
    if (launchStartedAt && Date.now() - launchStartedAt < 60_000) return status("starting", false, configured, config.baseUrl);
    launchStartedAt = 0;
    return status("stopped", false, configured, config.baseUrl);
  }
}

export async function startFlux3Worker(): Promise<Flux3WorkerStatus> {
  const config = flux3WorkerConfig();
  if (!config.token) throw new Error("FLUX3_WORKER_TOKEN is not configured.");
  const current = await readFlux3WorkerStatus();
  if (current.state === "error" && current.online) throw new Error(current.error || "FLUX.3 worker is in an error state.");
  if (current.online) return current;
  const python = join(config.workerRoot, ".venv", "Scripts", "python.exe");
  if (!existsSync(python)) throw new Error(`FLUX.3 Python runtime was not found at ${python}`);
  const logPath = flux3WorkerLogPath();
  launchStartedAt = Date.now();
  launchError = undefined;
  let launched;
  try {
    launched = await launchBackgroundService({
      label: "FLUX.3 Klein",
      command: python,
      args: [join(config.workerRoot, "worker.py"), "--host", "127.0.0.1", "--port", String(config.port)],
      cwd: config.workerRoot,
      logPath,
      env: { ...process.env, ...PYTHON_LOG_ENV, HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        FLUX3_WORKER_TOKEN: config.token, FLUX3_IDLE_UNLOAD_SEC: config.idleUnloadSec }
    });
  } catch (error) {
    launchError = `${errorMessage(error)} See ${logPath}`;
    throw error;
  }
  const exited = () => { if (launchStartedAt) launchError = `FLUX.3 worker exited before it became ready. See ${logPath}`; };
  if (launched.exitedEarly) exited();
  else if (launched.pid) watchProcessExit(launched.pid, exited);
  return status("starting", false, true, config.baseUrl);
}

/** Start if needed and wait until /health answers (the model itself loads lazily on the first job). */
export async function ensureFlux3WorkerOnline(timeoutMs = 30_000): Promise<Flux3WorkerStatus> {
  let current = await readFlux3WorkerStatus();
  if (current.online) return current;
  await startFlux3Worker();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(500);
    current = await readFlux3WorkerStatus();
    if (current.online) return current;
    if (current.state === "error") break;
  }
  throw new Error(current.error || "FLUX.3 worker did not come online.");
}

export async function stopFlux3Worker(): Promise<{ ok: true; stopped: boolean; status: Flux3WorkerStatus }> {
  const config = flux3WorkerConfig();
  const current = await readFlux3WorkerStatus();
  if (!current.online) return { ok: true, stopped: false, status: current };
  if (!config.token) throw new Error("Cannot stop the FLUX.3 worker safely without FLUX3_WORKER_TOKEN.");
  const response = await fetch(`${config.baseUrl}/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`FLUX.3 worker shutdown returned ${response.status}.`);
  launchStartedAt = 0;
  launchError = undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const next = await readFlux3WorkerStatus();
    if (!next.online) return { ok: true, stopped: true, status: next };
  }
  throw new Error("FLUX.3 worker did not stop cleanly.");
}

function status(state: Flux3WorkerStatus["state"], online: boolean, configured: boolean, endpoint: string, error?: string): Flux3WorkerStatus {
  return { service: "FLUX.3 Klein", state, online, configured, loaded: false, activeJobs: 0, endpoint, ...(error ? { error } : {}) };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
