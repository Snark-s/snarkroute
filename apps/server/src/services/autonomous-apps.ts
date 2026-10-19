import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { repoRoot } from "../server-paths";
import { registerLocalRuntimeController, registerLocalRuntimeEndpoint } from "./local-runtime-registry";
import { registerServiceLogProvider } from "./service-logs";

/*
 * Tove (Шорёк) and Factory (Фабрика): independent Python applications next to SnarkRoute.
 * The Мастерская only starts them through their own single-instance launchers and asks them
 * to stop through their own shutdown API. Their state comes from their health endpoints
 * (identity-checked), never from a PID alone. They are detached, so closing the Мастерская
 * or restarting SnarkRoute does not stop them.
 */

export type AutonomousAppId = "tove" | "factory";
export type AutonomousAppState = "stopped" | "starting" | "ready" | "working" | "paused" | "paused_gpu" | "error" | "stopping" | "unavailable";

export type AutonomousAppStatus = {
  id: AutonomousAppId;
  state: AutonomousAppState;
  running: boolean;
  url: string;
  mode?: string;
  pid?: number;
  current?: { title?: string; kind?: string } | null;
  error?: string;
};

type Definition = { id: AutonomousAppId; service: string; label: string; port: number; dir: string; module: string };

const appsRoot = () => join(repoRoot, "..", "..", "Приложения");

export const autonomousApps: Record<AutonomousAppId, Definition> = {
  tove: { id: "tove", service: "tove", label: "Шорёк", port: Number(process.env.TOVE_PORT ?? 4890),
    dir: process.env.TOVE_DIR ?? join(appsRoot(), "Tove"), module: "tove" },
  factory: { id: "factory", service: "factory", label: "Фабрика", port: Number(process.env.FACTORY_PORT ?? 4891),
    dir: process.env.FACTORY_DIR ?? join(appsRoot(), "Factory"), module: "factory" }
};

export function isAutonomousAppId(id: string): id is AutonomousAppId {
  return id === "tove" || id === "factory";
}

type Deps = {
  portOpen: (port: number) => Promise<boolean>;
  fetchJson: (url: string, init?: RequestInit) => Promise<{ ok: boolean; body: any }>;
  spawnLauncher: (definition: Definition) => void;
  installed: (definition: Definition) => boolean;
  now: () => number;
  wait: (ms: number) => Promise<void>;
};

const startedAt = new Map<AutonomousAppId, number>();
const stoppingAt = new Map<AutonomousAppId, number>();
const inflight = new Map<AutonomousAppId, Promise<AutonomousAppStatus>>();

const defaultDeps: Deps = {
  portOpen: (port) => new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(600);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  }),
  fetchJson: async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
    return { ok: response.ok, body: await response.json().catch(() => ({})) };
  },
  spawnLauncher: (definition) => {
    // The app's own launcher is idempotent and detaches the daemon; this child exits right away.
    const python = process.env.AUTONOMOUS_APPS_PYTHON ?? "python";
    const { SNARKROUTE_LAUNCHER_TOKEN: _token, API_PORT: _apiPort, ...env } = process.env;
    const child = spawn(python, ["-m", `${definition.module}.launcher`, "start", "--json"], {
      cwd: definition.dir, detached: true, env, stdio: "ignore", windowsHide: true
    });
    child.on("error", () => undefined);
    child.unref();
  },
  installed: (definition) => existsSync(join(definition.dir, definition.module, "launcher.py")),
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

let deps: Deps = defaultDeps;
export function setAutonomousAppDeps(overrides: Partial<Deps> | null) {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  startedAt.clear(); stoppingAt.clear(); inflight.clear();
}

const HEALTH_STATES: AutonomousAppState[] = ["starting", "ready", "working", "paused", "paused_gpu", "error", "stopping"];

export async function readAutonomousAppStatus(id: AutonomousAppId): Promise<AutonomousAppStatus> {
  const definition = autonomousApps[id];
  const url = `http://127.0.0.1:${definition.port}`;
  const base = { id, url };
  if (!deps.installed(definition)) return { ...base, state: "unavailable", running: false, error: `Приложение не найдено: ${definition.dir}` };
  const recent = (stamps: Map<AutonomousAppId, number>, windowMs: number) => stamps.has(id) && stamps.get(id)! > deps.now() - windowMs;
  const starting = recent(startedAt, 60_000);
  const stopping = recent(stoppingAt, 180_000);
  if (!await deps.portOpen(definition.port)) {
    stoppingAt.delete(id);
    return { ...base, state: starting ? "starting" : "stopped", running: false };
  }
  try {
    const { ok, body } = await deps.fetchJson(`${url}/api/health`);
    if (!ok || body?.service !== definition.service) {
      return { ...base, state: "unavailable", running: true, error: `Порт ${definition.port} занят другим процессом, не ${definition.label}` };
    }
    startedAt.delete(id);
    const state: AutonomousAppState = stopping ? "stopping" : HEALTH_STATES.includes(body.state) ? body.state : "error";
    return { ...base, state, running: true, mode: body.mode, pid: body.pid, current: body.current ?? null, ...(body.error ? { error: String(body.error) } : {}) };
  } catch (error) {
    return { ...base, state: starting ? "starting" : "error", running: true, error: `health не отвечает: ${error instanceof Error ? error.message : error}` };
  }
}

export async function startAutonomousApp(id: AutonomousAppId, timeoutMs = 45_000): Promise<AutonomousAppStatus> {
  const pending = inflight.get(id);
  if (pending) return pending; // repeated clicks never start a second instance
  const run = (async () => {
    const before = await readAutonomousAppStatus(id);
    if (before.state === "unavailable") throw new Error(before.error ?? "Приложение недоступно");
    if (before.running) return before;
    startedAt.set(id, deps.now());
    deps.spawnLauncher(autonomousApps[id]);
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
      const status = await readAutonomousAppStatus(id);
      if (status.running && status.state !== "starting") return status;
      await deps.wait(500);
    }
    throw new Error(`${autonomousApps[id].label} не ответил на health за ${Math.round(timeoutMs / 1000)} с — см. data/logs в папке приложения`);
  })().finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}

export async function stopAutonomousApp(id: AutonomousAppId, waitMs = 20_000): Promise<AutonomousAppStatus> {
  const definition = autonomousApps[id];
  const before = await readAutonomousAppStatus(id);
  if (!before.running) return before;
  if (before.state === "unavailable") throw new Error(before.error ?? "Порт занят другим процессом — не останавливаю чужой процесс");
  // The app finishes its current action, journals it and exits by itself.
  const { ok } = await deps.fetchJson(`${before.url}/api/system/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!ok) throw new Error(`${definition.label} не принял команду остановки`);
  stoppingAt.set(id, deps.now());
  const deadline = deps.now() + waitMs;
  while (deps.now() < deadline) {
    if (!await deps.portOpen(definition.port)) { stoppingAt.delete(id); return { ...before, state: "stopped", running: false, current: null }; }
    await deps.wait(500);
  }
  return readAutonomousAppStatus(id); // still finishing its current action: "stopping"
}

let registered = false;
/** Expose both apps in the Local Process Manager with health-based state and safe start/stop. */
export function registerAutonomousApps() {
  if (registered) return;
  registered = true;
  for (const definition of Object.values(autonomousApps)) {
    registerLocalRuntimeEndpoint({ id: definition.id, label: definition.label, endpoint: `http://127.0.0.1:${definition.port}`,
      provider: "autonomous-app", demand: "none", claimsOnStart: false, source: "builtin" });
    // Both apps keep their own log (their daemons run under pythonw, without a console).
    registerServiceLogProvider({ id: definition.id, label: definition.label, sources: () => [
      { id: "app", title: `${definition.module}.log`, path: join(definition.dir, "data", "logs", `${definition.module}.log`), owner: "own-file" }
    ] });
    registerLocalRuntimeController(definition.id, {
      start: () => startAutonomousApp(definition.id),
      stop: () => stopAutonomousApp(definition.id),
      status: async () => {
        const status = await readAutonomousAppStatus(definition.id);
        return {
          online: status.running && status.state !== "unavailable",
          state: status.state === "working" ? "busy" : status.state === "paused" || status.state === "paused_gpu" ? "ready"
            : status.state === "unavailable" ? "error" : status.state === "stopping" ? "busy" : status.state,
          busy: status.state === "working",
          detail: [status.mode ? `режим ${status.mode}` : "", status.current?.title ?? "", status.error ?? ""].filter(Boolean).join(" · ")
        };
      }
    });
  }
}
