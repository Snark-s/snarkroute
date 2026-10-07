import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { repoRoot } from "../server-paths";
import { errorMessage } from "../services/errors";
import { readSystemUpdateStatus, updateFromGitHub } from "../services/system-update";
import { openYue2Outputs, readYue2Status, startYue2, stopYue2, yue2Config } from "../services/yue2-local";
import { readBonsaiStatus, startBonsai, stopBonsai } from "../services/bonsai-local";
import { launcherControlRequest } from "../services/launcher-restart";
import { isLoopbackAddress, isLoopbackHost } from "./after-effects";
import { timingSafeEqual } from "node:crypto";
import { appMode } from "../services/env";
import { admissionForLocalRuntime, isLocalRuntimeId, LocalRuntimeAdmissionError, readLocalRuntimeSnapshot, startLocalRuntime, stopLocalRuntime } from "../services/local-runtime-supervisor";

type SystemAppDefinition = {
  id: string;
  name: string;
  description: string;
  url: string;
  port: number;
  packageName?: string;
  accent: string;
  icon: string;
  service?: "yue2";
};

const launcherPort = Number(process.env.LAUNCHER_PORT ?? 5172);
const studioPort = Number(process.env.STUDIO_PORT ?? 5173);
const canvasPort = Number(process.env.SNARKROUTE_PORT ?? 5174);
const brandeshmygPort = Number(process.env.BRANDESHMYG_PORT ?? 5175);

export const systemAppCatalog: readonly SystemAppDefinition[] = [
  { id: "living-canvas", name: "Живой холст", description: "Маршруты, модели и свободная сборка", url: `http://127.0.0.1:${canvasPort}`, port: canvasPort, packageName: "@snarkroute/snarkroute", accent: "violet", icon: "/snarkroute-icon.png" },
  { id: "boojum", name: "Boojum", description: "Редактор маршрутов и узлов", url: `http://127.0.0.1:${studioPort}`, port: studioPort, packageName: "@snarkroute/studio", accent: "amber", icon: "/boojumroute-icon.png" },
  { id: "brandeshmyg", name: "Брандешмыг", description: "Инструменты как отдельные приложения", url: `http://127.0.0.1:${brandeshmygPort}`, port: brandeshmygPort, packageName: "@snarkroute/brandeshmyg", accent: "lime", icon: "/brandeshmyg-icon.png" },
  { id: "h3", name: "H3", description: "Пространственная студия", url: `http://127.0.0.1:${studioPort}/h3`, port: studioPort, packageName: "@snarkroute/studio", accent: "cyan", icon: "/h3-studio-icon.png" },
  { id: "persona", name: "Jabberwock", description: "Продолжение задач с общей памятью", url: `http://127.0.0.1:${launcherPort}/persona`, port: launcherPort, packageName: "@snarkroute/launcher", accent: "rose", icon: "/jabberwock-icon.png" },
  { id: "yue2", name: "YuE2", description: "Локальная генерация музыки", url: yue2Config.url, port: yue2Config.port, accent: "cyan", icon: "/yue2-icon.png", service: "yue2" }
];
const launcherApp: SystemAppDefinition = { id: "launcher", name: "Мастерская", description: "Общий лаунчер", url: `http://127.0.0.1:${launcherPort}`, port: launcherPort, packageName: "@snarkroute/launcher", accent: "violet", icon: "sparkles" };

export async function registerSystemRoutes(app: FastifyInstance) {
  const local = (request: { ip: string; hostname: string; headers: { origin?: string } }) => {
    if (appMode() !== "local" || !isLoopbackAddress(request.ip) || !isLoopbackHost(request.hostname)) return false;
    if (!request.headers.origin) return true;
    try { const origin = new URL(request.headers.origin); return origin.protocol === "http:" && isLoopbackHost(origin.hostname); } catch { return false; }
  };
  const ownerAuthorized = (authorization: string | undefined) => {
    const token = process.env.SNARKROUTE_LAUNCHER_TOKEN;
    if (!token || !authorization) return false;
    const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(authorization);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  };
  app.get("/api/system/restart/ownership", async (request, reply) => {
    if (!local(request) || !ownerAuthorized(request.headers.authorization)) return reply.code(403).send({ ok: false });
    return { ok: true, pid: process.pid };
  });
  app.get("/api/system/restart", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    try { return await launcherControlRequest("status"); }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });
  app.post("/api/system/restart", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    try { return reply.code(202).send(await launcherControlRequest("restart", "POST")); }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });
  app.post("/api/system/restart/shutdown", async (request, reply) => {
    if (!local(request) || !ownerAuthorized(request.headers.authorization)) return reply.code(403).send({ ok: false });
    try {
      const owner = await launcherControlRequest("status");
      if (!owner.managed || owner.serverPid !== process.pid || owner.operation?.state !== "stopping"
        || !["restart", "shutdown"].includes(owner.operation.action ?? "")) return reply.code(409).send({ ok: false, error: "Active external launcher stop command not confirmed" });
      // The owning launcher remains alive and is waiting for this exact process.
      // Fastify closes jobs, route ownership and memory before the process exits.
      const timer = setTimeout(() => { void app.close().then(() => process.exit(0)).catch(error => app.log.error(error)); }, 100);
      timer.unref(); return reply.code(202).send({ ok: true });
    } catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });
  app.get("/api/system/bonsai", async (_request, reply) => {
    const state = await readBonsaiStatus();
    return reply.send({ ok: state.status !== "error", ...state });
  });

  app.post("/api/system/bonsai/start", async (_request, reply) => {
    try {
      return reply.code(202).send({ ok: true, ...await startBonsai() });
    } catch (error) {
      return reply.code(503).send({ ok: false, error: errorMessage(error), ...await readBonsaiStatus() });
    }
  });

  app.post("/api/system/bonsai/stop", async (_request, reply) => {
    try {
      return await stopBonsai();
    } catch (error) {
      return reply.code(503).send({ ok: false, error: errorMessage(error), ...await readBonsaiStatus() });
    }
  });

  app.get("/api/system/local-runtimes", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    return { ok: true, ...await readLocalRuntimeSnapshot() };
  });

  app.get<{ Params: { runtimeId: string }; Querystring: { intent?: string } }>("/api/system/local-runtimes/:runtimeId/admission", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    if (!isLocalRuntimeId(request.params.runtimeId)) return reply.code(404).send({ ok: false, error: "Unknown local runtime." });
    const intent = request.query.intent === "start" ? "start" : "workload";
    return { ok: true, ...await admissionForLocalRuntime(request.params.runtimeId, intent) };
  });

  app.post<{ Params: { runtimeId: string }; Body: { force?: boolean } }>("/api/system/local-runtimes/:runtimeId/start", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    if (!isLocalRuntimeId(request.params.runtimeId)) return reply.code(404).send({ ok: false, error: "Unknown local runtime." });
    try {
      return { ok: true, ...await startLocalRuntime(request.params.runtimeId, { force: request.body?.force === true }) };
    } catch (error) {
      if (error instanceof LocalRuntimeAdmissionError) {
        return reply.code(409).send({ ok: false, error: error.message, decision: error.decision, snapshot: await readLocalRuntimeSnapshot() });
      }
      return reply.code(503).send({ ok: false, error: errorMessage(error), snapshot: await readLocalRuntimeSnapshot() });
    }
  });

  app.post<{ Params: { runtimeId: string } }>("/api/system/local-runtimes/:runtimeId/stop", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    if (!isLocalRuntimeId(request.params.runtimeId)) return reply.code(404).send({ ok: false, error: "Unknown local runtime." });
    try {
      return { ok: true, ...await stopLocalRuntime(request.params.runtimeId) };
    } catch (error) {
      return reply.code(503).send({ ok: false, error: errorMessage(error), snapshot: await readLocalRuntimeSnapshot() });
    }
  });

  app.get("/api/system/update/status", async (request, reply) => {
    try {
      return await readSystemUpdateStatus();
    } catch (error) {
      return reply.code(500).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/system/update", async (request, reply) => {
    try {
      return await updateFromGitHub();
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Body: { studioPort?: number | string; snarkroutePort?: number | string } }>("/api/system/shutdown", async (request) => {
    scheduleLocalShutdown({
      studioPort: stringPort(request.body?.studioPort),
      snarkroutePort: stringPort(request.body?.snarkroutePort)
    });
    return { ok: true, message: "Shutdown requested." };
  });

  app.post<{ Body: { studioPort?: number | string } }>("/api/system/open-boojum", async (request) => {
    const studioPort = stringPort(request.body?.studioPort) ?? process.env.STUDIO_PORT ?? "5173";
    const url = `http://127.0.0.1:${studioPort}`;
    const open = await isPortListening(Number(studioPort));
    if (!open) startBoojumStudio(studioPort);
    return { ok: true, url, started: !open };
  });

  app.post<{ Body: { brandeshmygPort?: number | string } }>("/api/system/open-brandeshmyg", async (request) => {
    const brandeshmygPort = stringPort(request.body?.brandeshmygPort) ?? process.env.BRANDESHMYG_PORT ?? "5175";
    const url = `http://127.0.0.1:${brandeshmygPort}`;
    const open = await isPortListening(Number(brandeshmygPort));
    if (!open) startBrandeshmyg(brandeshmygPort);
    return { ok: true, url, started: !open };
  });

  app.get("/api/system/apps", async () => ({
    ok: true,
    apps: await Promise.all(systemAppCatalog.map(async ({ packageName: _packageName, port, service, ...entry }) => {
      const state = service === "yue2" ? await readYue2Status() : undefined;
      return { ...entry, running: state ? state.status !== "stopped" : await isPortListening(port), status: state?.status ?? (await isPortListening(port) ? "ready" : "stopped"), generating: state?.generating ?? false, error: state?.error };
    }))
  }));

  app.post<{ Params: { appId: string } }>("/api/system/apps/:appId/open", async (request, reply) => {
    const target = request.params.appId === "launcher" ? launcherApp : systemAppCatalog.find((entry) => entry.id === request.params.appId);
    if (!target) return reply.code(404).send({ ok: false, error: "Unknown local application." });
    if (target.service === "yue2") {
      try {
        const before = await readYue2Status();
        const state = await startYue2();
        return { ok: true, url: target.url, started: before.status === "stopped", status: state.status };
      } catch (error) {
        return reply.code(503).send({ ok: false, error: errorMessage(error) });
      }
    }
    const open = await isPortListening(target.port);
    if (!open) startSystemApp(target);
    return { ok: true, url: target.url, started: !open };
  });

  app.post("/api/system/apps/yue2/stop", async (_request, reply) => {
    try { return await stopYue2(); }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });

  app.post("/api/system/apps/yue2/outputs", async (_request, reply) => {
    try { return await openYue2Outputs(); }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });
}

function startSystemApp(target: SystemAppDefinition) {
  if (!target.packageName) throw new Error("Application has no package launcher.");
  const child = spawn("corepack", ["pnpm", "--filter", target.packageName, "dev"], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      ...(target.packageName === "@snarkroute/studio" ? { STUDIO_PORT: String(target.port) } : {}),
      ...(target.packageName === "@snarkroute/snarkroute" ? { SNARKROUTE_PORT: String(target.port) } : {}),
      ...(target.packageName === "@snarkroute/brandeshmyg" ? { BRANDESHMYG_PORT: String(target.port) } : {}),
      ...(target.packageName === "@snarkroute/launcher" ? { LAUNCHER_PORT: String(target.port) } : {}),
      VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4317}`
    },
    shell: process.platform === "win32",
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function startBoojumStudio(studioPort: string) {
  const child = spawn("corepack", ["pnpm", "--filter", "@snarkroute/studio", "dev"], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      STUDIO_PORT: studioPort,
      VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4317}`
    },
    shell: process.platform === "win32",
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function startBrandeshmyg(brandeshmygPort: string) {
  const child = spawn("corepack", ["pnpm", "--filter", "@snarkroute/brandeshmyg", "dev"], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      BRANDESHMYG_PORT: brandeshmygPort,
      VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4317}`
    },
    shell: process.platform === "win32",
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(700, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function scheduleLocalShutdown(ports: { studioPort?: string; snarkroutePort?: string } = {}) {
  if (process.env.SNARKROUTE_SHUTDOWN_DRY_RUN === "1") return;
  const scriptPath = join(repoRoot, "stop-snarkroute.ps1");
  setTimeout(() => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        ...(ports.studioPort ? { STUDIO_PORT: ports.studioPort } : {}),
        ...(ports.snarkroutePort ? { SNARKROUTE_PORT: ports.snarkroutePort } : {})
      },
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  }, 200);
}

function stringPort(value: number | string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : undefined;
}
