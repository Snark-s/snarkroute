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
  const child = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", join(repoRoot, "start-yue2.ps1"), "-NoOpen"
  ], { cwd: repoRoot, detached: true, windowsHide: true, stdio: "ignore", shell: false });
  child.once("error", (error) => { launchError = error; });
  child.unref();
  for (let attempt = 0; attempt < 360; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (launchError) throw launchError;
    const state = await readYue2Status();
    if (state.status === "ready" || state.status === "generating" || state.status === "error") return state;
  }
  throw new Error("YuE2 did not become ready within 3 minutes. See ~/YuE/outputs/yue2-service.log.");
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
