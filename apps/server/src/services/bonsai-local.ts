import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { totalmem } from "node:os";
import { join } from "node:path";
import { localOpenAiConfig } from "../providers/local-openai";
import { repoRoot } from "../server-paths";

export type BonsaiRuntimeConfig = {
  baseUrl: string;
  demoPath: string;
  modelId: string;
  port: number;
};

export type BonsaiStatus = {
  service: "Bonsai 2 27B";
  status: "stopped" | "starting" | "loading" | "ready" | "error";
  model_loaded: boolean;
  endpoint: string;
  model_id?: string;
  error?: string;
};

type ReadStatusOptions = {
  config?: BonsaiRuntimeConfig;
  fetchImpl?: typeof fetch;
  portListening?: (port: number) => Promise<boolean>;
};

let launchStartedAt = 0;
let launchError: string | undefined;

export function bonsaiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): BonsaiRuntimeConfig {
  const local = localOpenAiConfig(env);
  const parsed = new URL(local.baseUrl);
  if (!isLoopback(parsed.hostname)) throw new Error("Bonsai lifecycle control is allowed only for a loopback LOCAL_LLM_BASE_URL.");
  return {
    baseUrl: local.baseUrl,
    demoPath: env.BONSAI_DEMO_PATH?.trim() || "I:\\AI\\Bonsai-demo",
    modelId: local.fallbackModelId,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
  };
}

export async function readBonsaiStatus(options: ReadStatusOptions = {}): Promise<BonsaiStatus> {
  let config: BonsaiRuntimeConfig;
  try {
    config = options.config ?? bonsaiRuntimeConfig();
  } catch (error) {
    return status("error", false, "", undefined, errorMessage(error));
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const portListening = options.portListening ?? isPortListening;
  const endpoint = config.baseUrl;

  try {
    const response = await fetchImpl(`${endpoint}/models`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1500)
    });
    if (response.ok) {
      const payload = await response.json() as { data?: unknown };
      const modelIds = Array.isArray(payload.data) ? payload.data.flatMap((entry) => {
        const id = recordString(entry, "id");
        return id ? [id] : [];
      }) : [];
      const modelId = modelIds.find((id) => id === config.modelId || isBonsaiModel(id));
      if (!modelId) return status("error", false, endpoint, undefined, `Port ${config.port} is occupied by another service or model.`);
      launchStartedAt = 0;
      launchError = undefined;
      return status("ready", true, endpoint, modelId);
    }
    if (response.status === 503 && await portListening(config.port)) return status("loading", false, endpoint);
    if (await portListening(config.port)) return status("error", false, endpoint, undefined, `Port ${config.port} is occupied by another service.`);
  } catch {
    if (await portListening(config.port)) return status("loading", false, endpoint);
  }

  if (launchError) return status("error", false, endpoint, undefined, launchError);
  if (launchStartedAt && Date.now() - launchStartedAt < 5 * 60_000) return status("starting", false, endpoint);
  launchStartedAt = 0;
  return status("stopped", false, endpoint);
}

export async function startBonsai(): Promise<BonsaiStatus> {
  const config = bonsaiRuntimeConfig();
  const current = await readBonsaiStatus({ config });
  if (current.status === "error") throw new Error(current.error || "Bonsai is in an error state.");
  if (current.status !== "stopped") return current;
  if (process.platform !== "win32") throw new Error("The installed Bonsai launcher is currently configured for Windows only.");
  const upstreamLauncher = join(config.demoPath, "scripts", "start_llama_server.ps1");
  if (!existsSync(upstreamLauncher)) throw new Error(`Bonsai launcher was not found at ${upstreamLauncher}`);
  const launch = resolveLaunchCommand(config);

  launchError = undefined;
  launchStartedAt = Date.now();
  const logDirectory = join(repoRoot, "apps", "server", "data");
  const logPath = join(logDirectory, "bonsai-runtime.log");
  mkdirSync(logDirectory, { recursive: true });
  const log = openSync(logPath, "a");
  const child = spawn(launch.executable, launch.args, {
    cwd: config.demoPath,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    shell: false,
    env: process.env
  });
  closeSync(log);
  child.once("error", (error) => { launchError = `${error.message} See ${logPath}`; });
  child.once("exit", (code) => {
    if (launchStartedAt) launchError = `Bonsai launcher exited before the model became ready (code ${code ?? "unknown"}). See ${logPath}`;
  });
  child.unref();
  return status("starting", false, config.baseUrl);
}

function resolveLaunchCommand(config: BonsaiRuntimeConfig): { executable: string; args: string[] } {
  const binaryCandidates = [
    join(config.demoPath, "bin", "cuda", "llama-server.exe"),
    join(config.demoPath, "bin", "hip", "llama-server.exe"),
    join(config.demoPath, "bin", "vulkan", "llama-server.exe"),
    join(config.demoPath, "bin", "cpu", "llama-server.exe"),
    join(config.demoPath, "llama.cpp", "build", "bin", "Release", "llama-server.exe"),
    join(config.demoPath, "llama.cpp", "build", "bin", "llama-server.exe")
  ];
  const executable = binaryCandidates.find(existsSync);
  if (!executable) throw new Error(`Official Bonsai llama-server.exe was not found under ${config.demoPath}`);

  const modelDirectory = join(config.demoPath, "models", "bonsai2-gguf", "27B");
  if (!existsSync(modelDirectory)) throw new Error(`Bonsai 2 27B model directory was not found at ${modelDirectory}`);
  const filenames = readdirSync(modelDirectory);
  const modelName = filenames.find((name) => /-PQ2_0\.gguf$/i.test(name) && !/mmproj|dspark|kv-bias/i.test(name));
  if (!modelName) throw new Error(`Bonsai 2 27B PQ2_0 model was not found at ${modelDirectory}`);
  const mmprojName = filenames.find((name) => /mmproj.*\.gguf$/i.test(name));
  const context = positiveInteger(process.env.BONSAI_CTX) ?? recommendedContextSize();
  const gpuLayers = process.env.BONSAI_NGL?.trim() || (executable.includes(`${join("bin", "cpu")}\\`) ? "0" : "99");
  const parallel = positiveInteger(process.env.BONSAI_PARALLEL) ?? 1;
  const args = [
    "-m", join(modelDirectory, modelName),
    "--host", "127.0.0.1",
    "--port", String(config.port),
    "-ngl", gpuLayers,
    "-fa", "on",
    "-c", String(context),
    "--parallel", String(parallel),
    "--temp", "1.0",
    "--top-p", "0.95",
    "--top-k", "20",
    "--min-p", "0.05",
    "--jinja"
  ];
  if (mmprojName) args.push("--mmproj", join(modelDirectory, mmprojName));
  const webUiConfig = join(config.demoPath, "scripts", "webui-config.json");
  if (existsSync(webUiConfig)) args.push("--webui-config-file", webUiConfig);
  return { executable, args };
}

function recommendedContextSize(): number {
  const memoryGb = Math.floor(totalmem() / 1024 ** 3);
  if (memoryGb <= 11) return 8192;
  if (memoryGb <= 23) return 16384;
  if (memoryGb <= 35) return 32768;
  if (memoryGb <= 71) return 65536;
  return 131072;
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function stopBonsai(): Promise<{ ok: true; stopped: boolean; status: BonsaiStatus }> {
  const config = bonsaiRuntimeConfig();
  const current = await readBonsaiStatus({ config });
  if (current.status === "stopped") return { ok: true, stopped: false, status: current };
  if (current.status === "error") throw new Error(current.error || "Refusing to stop an unrecognized service.");
  const stopper = join(repoRoot, "scripts", "stop-bonsai.ps1");
  if (!existsSync(stopper)) throw new Error(`SnarkRoute Bonsai stop script was not found at ${stopper}`);

  await runPowerShell(stopper, ["-BonsaiDemoPath", config.demoPath, "-Port", String(config.port)]);
  launchStartedAt = 0;
  launchError = undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const next = await readBonsaiStatus({ config });
    if (next.status === "stopped") return { ok: true, stopped: true, status: next };
    await delay(250);
  }
  throw new Error("Bonsai did not stop cleanly; llama-server is still listening.");
}

function runPowerShell(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, ...args
    ], { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`)));
  });
}

function status(state: BonsaiStatus["status"], loaded: boolean, endpoint: string, modelId?: string, error?: string): BonsaiStatus {
  return { service: "Bonsai 2 27B", status: state, model_loaded: loaded, endpoint, ...(modelId ? { model_id: modelId } : {}), ...(error ? { error } : {}) };
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

function isBonsaiModel(id: string): boolean {
  return /(?:^|[\/_-])(?:ternary-)?bonsai-?2(?:[\/_-])?27b(?:[\/_\-.]|$)/i.test(id);
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname.endsWith(".localhost");
}

function recordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
