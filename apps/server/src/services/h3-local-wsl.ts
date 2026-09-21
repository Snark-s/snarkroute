import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { inspectH3Connection, type H3ConnectionStatus } from "./h3-connection";

const execFileAsync = promisify(execFile);

export type H3LocalWslStatus = {
  supported: boolean;
  distro: string;
  workerUrl: string;
  running: boolean;
  reason?: string;
};

export type StartedH3LocalWsl = {
  status: H3ConnectionStatus;
  serviceToken: string;
  local: H3LocalWslStatus;
};

export function h3LocalWslStatus(connection?: H3ConnectionStatus): H3LocalWslStatus {
  const config = localConfig();
  const supported = process.platform === "win32";
  const localConnection = connection?.workerUrl === config.workerUrl;
  return {
    supported,
    distro: config.distro,
    workerUrl: config.workerUrl,
    running: Boolean(localConnection && connection?.ready),
    ...(!supported ? { reason: "Local H3 one-click launch is available on Windows with WSL2." } : {})
  };
}

export async function startH3LocalWsl(): Promise<StartedH3LocalWsl> {
  const config = localConfig();
  if (process.platform !== "win32") throw new Error("Local H3 launch requires Windows with WSL2.");

  const serviceToken = await readServiceToken(config);
  const current = await inspectH3Connection({
    workerUrl: config.workerUrl,
    serviceToken,
    timeoutMs: 2_000
  });
  if (current.ready) {
    return { status: current, serviceToken, local: h3LocalWslStatus(current) };
  }

  const child = spawn(
    "wsl.exe",
    [
      "-d",
      config.distro,
      "--",
      "bash",
      "-lc",
      `H3_LOCAL_FOREGROUND=1 H3_ACCEPT_MODEL_LICENSE=1 ${config.startScript}`
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  let launcherFailure: Error | undefined;
  let launcherExited = false;
  let launcherOutput = "";
  const collectOutput = (chunk: Buffer) => {
    launcherOutput = `${launcherOutput}${chunk.toString("utf8")}`.slice(-4_000);
  };
  child.stdout?.on("data", collectOutput);
  child.stderr?.on("data", collectOutput);
  child.once("error", (error) => { launcherFailure = error; });
  child.once("exit", (code, signal) => {
    launcherExited = true;
    if (code && !launcherFailure) {
      const detail = launcherOutput.trim();
      launcherFailure = new Error(
        `Local H3 launcher exited with code ${code}${signal ? ` (${signal})` : ""}.`
        + (detail ? ` ${detail}` : "")
      );
    }
  });
  child.unref();

  const deadline = Date.now() + config.startupTimeoutMs;
  let last = current;
  while (Date.now() < deadline) {
    await delay(2_000);
    if (launcherFailure) throw launcherFailure;
    if (launcherExited) throw new Error("Local H3 launcher exited before the worker became ready.");
    last = await inspectH3Connection({
      workerUrl: config.workerUrl,
      serviceToken,
      timeoutMs: 3_000
    });
    if (last.ready) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      return { status: last, serviceToken, local: h3LocalWslStatus(last) };
    }
  }
  throw new Error(last.error ?? last.reason ?? "Local H3 worker did not become ready in time.");
}

export async function stopH3LocalWsl(): Promise<H3LocalWslStatus> {
  const config = localConfig();
  if (process.platform !== "win32") throw new Error("Local H3 stop requires Windows with WSL2.");
  await execFileAsync(
    "wsl.exe",
    ["-d", config.distro, "--", "bash", "-lc", config.stopScript],
    { timeout: 30_000, windowsHide: true }
  );
  return h3LocalWslStatus();
}

async function readServiceToken(config: ReturnType<typeof localConfig>): Promise<string> {
  const { stdout } = await execFileAsync(
    "wsl.exe",
    ["-d", config.distro, "--", "cat", config.tokenFile],
    { timeout: 15_000, windowsHide: true, maxBuffer: 4_096 }
  );
  const token = stdout.trim();
  if (!token || !/^[\x21-\x7E]+$/.test(token)) {
    throw new Error(`Local H3 worker token is missing or invalid: ${config.tokenFile}`);
  }
  return token;
}

function localConfig() {
  const distro = safeName(process.env.H3_LOCAL_WSL_DISTRO?.trim() || "Ubuntu-24.04", "WSL distro");
  const port = positiveInteger(process.env.H3_LOCAL_PORT, 18_080);
  const startScript = safeAbsolutePath(
    process.env.H3_LOCAL_WSL_START_SCRIPT?.trim()
      || "/home/serge/h3/runtime/snarkroute-h3/scripts/start_local_wsl.sh",
    "start script"
  );
  const stopScript = safeAbsolutePath(
    process.env.H3_LOCAL_WSL_STOP_SCRIPT?.trim()
      || "/home/serge/h3/runtime/snarkroute-h3/scripts/stop_local_wsl.sh",
    "stop script"
  );
  const tokenFile = safeAbsolutePath(
    process.env.H3_LOCAL_WSL_TOKEN_FILE?.trim() || "/home/serge/h3/runtime/worker-token",
    "token file"
  );
  return {
    distro,
    workerUrl: `http://127.0.0.1:${port}`,
    startScript,
    stopScript,
    tokenFile,
    startupTimeoutMs: positiveInteger(process.env.H3_LOCAL_STARTUP_TIMEOUT_MS, 5 * 60_000)
  };
}

function safeName(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid local H3 ${label}.`);
  return value;
}

function safeAbsolutePath(value: string, label: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`Invalid local H3 ${label}.`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
