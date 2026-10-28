import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { localServiceHome, localServicePort, localServiceUrl } from "./local-service-endpoints";
import { killProcessTree, launchBackgroundService, processAlive } from "./background-process";
import { managedLogPath } from "./service-logs";

/** Local 3D previsualisation Studio, not an AI/video provider. */
export const cozyClayUrl = (): string => localServiceUrl("cozyclay", "/app/");
export const cozyClayManagedLog = (): string => managedLogPath("cozyclay");
export const cozyClayManualLog = (): string | undefined => {
  const home = localServiceHome("cozyclay");
  return home ? join(home, "data", "logs", "cozyclay-manual.log") : undefined;
};

export type CozyClayStatus = {
  status: "ready" | "stopped" | "starting" | "error" | "unavailable" | "occupied";
  running: boolean;
  /** Only true if this exact server instance owns the process it started. */
  managed: boolean;
  error?: string;
};

let ownedPid: number | undefined;
let pending: Promise<CozyClayStatus> | undefined;
let errorText: string | undefined;

type Installed = { home: string; binary: string; version: string; runtime: string; upgraded: boolean };
function installed(): Installed | undefined {
  const root = localServiceHome("cozyclay");
  if (!root) return undefined;
  // Prefer the independently verified 3.1.3 package without overwriting 3.1.2.
  for (const home of [join(root, "upgrade-3.1.3"), root]) {
    const binary = join(home, "node_modules", "cozyclay", "bin", "cozyclay.mjs");
    const packageFile = join(home, "node_modules", "cozyclay", "package.json");
    if (!existsSync(binary) || !existsSync(packageFile)) continue;
    try {
      const data = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: string };
      if (!data.version || !/^\d+\.\d+\.\d+$/.test(data.version)) continue;
      const runtime = join(home, "mcp-runtime-cache", data.version);
      if (!existsSync(join(runtime, "mcp", "server.mjs"))) continue;
      return { home, binary, version: data.version, runtime, upgraded: home !== root };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function studioProbe(): Promise<"ready" | "occupied" | "down"> {
  try {
    const response = await fetch(cozyClayUrl(), {
      redirect: "manual", signal: AbortSignal.timeout(1200)
    });
    if (!response.ok) return "occupied";
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) return "occupied";
    const html = (await response.text()).slice(0, 65_536);
    return /cozyclay/i.test(html) ? "ready" : "occupied";
  } catch {
    return "down";
  }
}

export async function readCozyClayStatus(): Promise<CozyClayStatus> {
  try {
    if (!installed()) return {
      status: "unavailable", running: false, managed: false,
      error: "CozyClay is not installed in the registered local folder."
    };
    const check = await studioProbe();
    if (check === "ready") {
      errorText = undefined;
      return { status: "ready", running: true, managed: !!ownedPid && processAlive(ownedPid) };
    }
    if (check === "occupied") return {
      status: "occupied", running: false, managed: false,
      error: "Port 5180 is occupied by an unverified HTTP service; refusing to start CozyClay there."
    };
  } catch (error) {
    return { status: "error", running: false, managed: false, error: String(error) };
  }
  if (ownedPid && !processAlive(ownedPid)) {
    ownedPid = undefined;
    errorText ||= "CozyClay exited. Open its terminal for logs.";
  }
  if (pending) return { status: "starting", running: false, managed: !!ownedPid };
  return errorText
    ? { status: "error", running: false, managed: false, error: errorText }
    : { status: "stopped", running: false, managed: false };
}

export function startCozyClay(): Promise<CozyClayStatus> {
  if (pending) return pending;
  pending = (async (): Promise<CozyClayStatus> => {
    const before = await readCozyClayStatus();
    if (before.running) return before;
    if (before.status === "occupied" || before.status === "unavailable") {
      throw new Error(before.error);
    }
    const app = installed();
    if (!app) throw new Error("CozyClay installation not found");
    // Do not download/install during start: the owner validated this runtime.
    if (!existsSync(join(app.runtime, "mcp", "project-camera.mjs"))) {
      throw new Error("CozyClay MCP cache is not prepared. Run its local setup and diagnostics.");
    }
    errorText = undefined;
    try {
      const launch = await launchBackgroundService({
        label: "CozyClay Studio",
        command: process.execPath,
        args: [app.binary, "--no-star", "--no-update-check"],
        cwd: app.home,
        logPath: cozyClayManagedLog(),
        env: {
          ...process.env,
          COZYCLAY_MCP_RUNTIME_DIR: app.runtime,
          COZYCLAY_CONFIG_DIR: app.upgraded ? join(app.home, "data", "config") : process.env.COZYCLAY_CONFIG_DIR,
          COZYCLAY_LIVE_PORT: String(localServicePort("cozyclay_live")),
          COZYCLAY_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
          ...(app.upgraded ? {
            OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "",
            GEMINI_API_KEY: "", GOOGLE_API_KEY: "", CLIPROXY_API_KEY: "",
            MINIMAX_API_KEY: "", MINIMAX_CN_API_KEY: ""
          } : {})
        }
      });
      if (launch.pid) ownedPid = launch.pid;
      if (launch.exitedEarly) throw new Error("CozyClay exited at startup. See its terminal log.");
      for (let i = 0; i < 50; i++) {
        const check = await studioProbe();
        if (check === "ready") return { status: "ready", running: true, managed: !!ownedPid };
        if (check === "occupied") throw new Error("Port 5180 is owned by an unverified service.");
        if (ownedPid && !processAlive(ownedPid)) break;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      throw new Error("CozyClay did not start. See Терминалы > CozyClay.");
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      throw error;
    }
  })().finally(() => { pending = undefined; });
  return pending!;
}

export async function stopCozyClay(confirmExternalStop = false): Promise<CozyClayStatus> {
  if (!ownedPid || !processAlive(ownedPid)) {
    if (!confirmExternalStop) {
      throw new Error("CozyClay was launched manually. Save the scene and confirm the external stop.");
    }
    const home = localServiceHome("cozyclay");
    if (!home) throw new Error("CozyClay installation path not registered.");
    const safeStopScript = join(home, "stop-verified-external.ps1");
    if (!existsSync(safeStopScript)) throw new Error("Verified CozyClay stop helper is not installed.");
    // The helper checks the loopback port owner, executable path, exact CozyClay
    // installation and process creation time twice before terminating one PID.
    const { stdout } = await promisify(execFile)("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", safeStopScript
    ], { windowsHide: true, timeout: 15_000, maxBuffer: 32_768 });
    if (!stdout.includes("COZYCLAY_STOPPED")) throw new Error("CozyClay did not confirm shutdown.");
    errorText = undefined;
    return readCozyClayStatus();
  }
  await killProcessTree(ownedPid);
  ownedPid = undefined;
  errorText = undefined;
  return readCozyClayStatus();
}
