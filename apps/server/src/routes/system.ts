import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { repoRoot } from "../server-paths";
import { errorMessage } from "../services/errors";
import { readSystemUpdateStatus, updateFromGitHub } from "../services/system-update";
import { openYue2Outputs, readYue2Status, startYue2, stopYue2, yue2Config } from "../services/yue2-local";

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
