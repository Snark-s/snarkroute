import { spawn } from "node:child_process";
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
