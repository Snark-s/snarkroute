import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../server-paths";

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
    const response = await fetch("http://127.0.0.1:11434/api/ps", { signal: AbortSignal.timeout(1200) });
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
  const logDirectory = join(repoRoot, "apps", "server", "data");
  const logPath = join(logDirectory, "ollama-runtime.log");
  mkdirSync(logDirectory, { recursive: true });
  const log = openSync(logPath, "a");

  launchStartedAt = Date.now();
  launchError = undefined;
  const child = spawn("ollama.exe", ["serve"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    shell: false,
    env: process.env
  });
  closeSync(log);
  ownedPid = child.pid;
  child.once("error", error => { launchError = `${error.message}. See ${logPath}`; });
  child.once("exit", code => {
    if (launchStartedAt) launchError = `Ollama exited before becoming ready (code ${code ?? "unknown"}). See ${logPath}`;
    ownedPid = undefined;
  });
  child.unref();
  return { service: "Ollama", status: "starting", online: false, residentModels: [] };
}

export async function stopOllama(): Promise<{ ok: true; releasedModels: string[] }> {
  const current = await readOllamaStatus();
  if (!current.online) return { ok: true, releasedModels: [] };

  const releasedModels: string[] = [];
  for (const model of current.residentModels) {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "", keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Ollama could not unload ${model}: HTTP ${response.status}`);
    releasedModels.push(model);
  }

  if (!releasedModels.length && ownedPid) {
    try { process.kill(ownedPid); } catch {}
    ownedPid = undefined;
  }
  return { ok: true, releasedModels };
}
