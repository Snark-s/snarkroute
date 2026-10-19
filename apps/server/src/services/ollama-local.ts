import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../server-paths";
import { localServiceUrl } from "./local-service-endpoints";
import { killProcessTree, launchBackgroundService, watchProcessExit } from "./background-process";
import type { ServiceLogSourceDef } from "./service-logs";

export function ollamaLogPath(): string {
  return join(repoRoot, "apps", "server", "data", "ollama-runtime.log");
}

/** Our launch log, plus the Ollama tray app's own server.log when Ollama was started outside SnarkRoute. */
export function ollamaLogSources(): ServiceLogSourceDef[] {
  const sources: ServiceLogSourceDef[] = [{ id: "runtime", title: "Запуск из Мастерской", path: ollamaLogPath(), owner: "managed" }];
  const appLog = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Ollama", "server.log") : undefined;
  if (appLog && existsSync(appLog)) sources.push({ id: "app", title: "Ollama (трей, server.log)", path: appLog, owner: "own-file" });
  return sources;
}

export type OllamaStatus = {
  service: "Ollama";
  status: "stopped" | "starting" | "ready" | "error";
  online: boolean;
  residentModels: string[];
  error?: string;
};

let launchStartedAt = 0;
let launchError: string | undefined;
let ownedPid: number | undefined;

export async function readOllamaStatus(): Promise<OllamaStatus> {
  try {
    const response = await fetch(localServiceUrl("ollama_inference", "/api/ps"), { signal: AbortSignal.timeout(1200) });
    if (!response.ok) throw new Error(`Ollama /api/ps returned ${response.status}`);
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    launchStartedAt = 0;
    launchError = undefined;
    return {
      service: "Ollama",
      status: "ready",
      online: true,
      residentModels: (body.models ?? []).flatMap(model => {
        const name = model.name ?? model.model;
        return name ? [name] : [];
      })
    };
  } catch (error) {
    if (launchError) return { service: "Ollama", status: "error", online: false, residentModels: [], error: launchError };
    if (launchStartedAt && Date.now() - launchStartedAt < 30_000) {
      return { service: "Ollama", status: "starting", online: false, residentModels: [] };
    }
    launchStartedAt = 0;
    return { service: "Ollama", status: "stopped", online: false, residentModels: [], ...(error instanceof Error && !/abort|fetch/i.test(error.message) ? { error: error.message } : {}) };
  }
}

export async function startOllama(): Promise<OllamaStatus> {
  const current = await readOllamaStatus();
  if (current.online || current.status === "starting") return current;
  const logPath = ollamaLogPath();

  launchStartedAt = Date.now();
  launchError = undefined;
  // Windowless: runner subprocesses inherit the hidden console instead of opening terminal windows.
  let launched;
  try {
    launched = await launchBackgroundService({ label: "Ollama", command: "ollama.exe", args: ["serve"], cwd: repoRoot, logPath, env: process.env });
  } catch (error) {
    launchError = `${error instanceof Error ? error.message : String(error)}. See ${logPath}`;
    throw error;
  }
  const exited = () => {
    if (launchStartedAt) launchError = `Ollama exited before becoming ready. See ${logPath}`;
    ownedPid = undefined;
  };
  if (launched.exitedEarly) exited();
  else if (launched.pid) { ownedPid = launched.pid; watchProcessExit(launched.pid, exited); }
  return { service: "Ollama", status: "starting", online: false, residentModels: [] };
}

export async function stopOllama(): Promise<{ ok: true; releasedModels: string[] }> {
  const current = await readOllamaStatus();
  if (!current.online) return { ok: true, releasedModels: [] };

  const releasedModels: string[] = [];
  for (const model of current.residentModels) {
    const response = await fetch(localServiceUrl("ollama_inference", "/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "", keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Ollama could not unload ${model}: HTTP ${response.status}`);
    releasedModels.push(model);
  }

  if (!releasedModels.length && ownedPid) {
    await killProcessTree(ownedPid);
    ownedPid = undefined;
  }
  return { ok: true, releasedModels };
}
