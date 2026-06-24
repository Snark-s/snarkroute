import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { repoRoot } from "../server-paths";
import { errorMessage } from "../services/errors";
import { readSystemUpdateStatus, updateFromGitHub } from "../services/system-update";

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
