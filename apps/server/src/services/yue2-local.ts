import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../server-paths";

type Yue2Config = {
  wslDistro: string;
  linuxUser: string;
  yuePath: string;
  python: string;
  port: number;
  url: string;
};

export const yue2Config: Yue2Config = JSON.parse(readFileSync(join(repoRoot, "config", "yue2.local.json"), "utf8"));

export type Yue2Status = {
  service?: "YuE2";
  status: "stopped" | "starting" | "loading" | "ready" | "generating" | "error";
  stage?: string;
  model_loaded: boolean;
  generating: boolean;
  error?: string | null;
};

export async function readYue2Status(): Promise<Yue2Status> {
  try {
    const response = await fetch(`${yue2Config.url}/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) throw new Error(`Health returned ${response.status}`);
    const state = await response.json() as Yue2Status;
    if (state.service !== "YuE2" || !["loading", "ready", "generating", "error"].includes(state.status)) {
      return { status: "error", model_loaded: false, generating: false, error: `Port ${yue2Config.port} is occupied by another service.` };
    }
    return state;
  } catch {
    return { status: "stopped", model_loaded: false, generating: false };
  }
}

export async function startYue2(): Promise<Yue2Status> {
  const current = await readYue2Status();
  if (current.status === "error") throw new Error(current.error || "YuE2 is in an error state.");
  if (current.status !== "stopped") return current;

  let launchError: Error | undefined;
  let launchExitCode: number | null | undefined;
  let launchExitSignal: NodeJS.Signals | null | undefined;
  let launchExitedAt = 0;
  let launcherOutput = "";

  const child = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", join(repoRoot, "start-yue2.ps1"), "-NoOpen"
  ], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  const capture = (chunk: Buffer | string) => {
    launcherOutput = boundedOutput(launcherOutput + String(chunk));
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("error", (error) => { launchError = error; });
  child.once("exit", (code, signal) => {
    launchExitCode = code;
    launchExitSignal = signal;
    launchExitedAt = Date.now();
    if (code && code !== 0 && !launchError) {
      launchError = new Error(yue2LauncherFailureMessage(code, signal, launcherOutput));
    }
  });

  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(500);
    if (launchError) throw launchError;

    const state = await readYue2Status();
    if (state.status === "loading" || state.status === "ready" || state.status === "generating") return state;
    if (state.status === "error") {
      throw new Error(`YuE2 failed while loading: ${state.error || state.stage || "unknown error"}`);
    }

    if (launchExitCode === 0 && launchExitedAt && Date.now() - launchExitedAt > 2500) {
      throw new Error(
        `YuE2 launcher exited successfully, but the service never appeared on ${yue2Config.url}.\n`
        + diagnosticOutput(launcherOutput)
      );
    }
  }

  try { child.kill(); } catch {}
  throw new Error(
    `YuE2 service did not appear within 60 seconds.\n`
    + (launchExitCode !== undefined
      ? `Launcher exit: ${launchExitCode ?? "signal"}${launchExitSignal ? ` (${launchExitSignal})` : ""}.\n`
      : "Launcher is still running.\n")
    + diagnosticOutput(launcherOutput)
    + "WSL service log: /home/serge/YuE/outputs/yue2-service.log"
  );
}

export async function stopYue2() {
  const current = await readYue2Status();
  if (current.status === "stopped") return { ok: true, stopped: false };
  const response = await fetch(`${yue2Config.url}/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`YuE2 shutdown returned ${response.status}`);
  return { ok: true, stopped: true };
}

export async function openYue2Outputs(id?: string) {
  const response = await fetch(`${yue2Config.url}/open-output-folder`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(id ? { id } : {}), signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`YuE2 folder request returned ${response.status}`);
  return response.json();
}

export function yue2LauncherFailureMessage(code: number | null, signal: NodeJS.Signals | null | undefined, output: string): string {
  return `YuE2 launcher failed${code !== null ? ` with exit code ${code}` : ""}${signal ? ` (${signal})` : ""}.\n`
    + diagnosticOutput(output)
    + "WSL service log: /home/serge/YuE/outputs/yue2-service.log";
}

function diagnosticOutput(output: string): string {
  const text = output.trim();
  return text ? `Launcher output:\n${text}\n` : "Launcher produced no diagnostic output.\n";
}

function boundedOutput(value: string): string {
  const max = 12_000;
  return value.length <= max ? value : value.slice(value.length - max);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
