import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import { localServiceHome, localServicePort } from "../services/local-service-endpoints";
import { autonomousApps, isAutonomousAppId, readAutonomousAppStatus, registerAutonomousApps, startAutonomousApp, stopAutonomousApp } from "../services/autonomous-apps";
import { admissionForLocalRuntime, isLocalRuntimeId, LocalRuntimeAdmissionError, readLocalRuntimeSnapshot, startLocalRuntime, stopLocalRuntime } from "../services/local-runtime-supervisor";
import { readSnarkBridgeLogs, readSnarkBridgeStatus, restartSnarkBridge } from "../services/snarkbridge-local";
import { launchBackgroundService } from "../services/background-process";
import { listServiceLogs, managedLogPath, readServiceLogChunk, registerServiceLogProvider, startServiceLogMaintenance, type ServiceLogSourceDef } from "../services/service-logs";
import { recentLocalRuntimeSnapshot } from "../services/local-runtime-supervisor";
import { readSecretaryInbox } from "../services/secretary-inbox";
import { registerBuzhaModelGateway } from "./buzha-model-gateway";
import { registerModelExposureRoutes } from "./model-exposure";
import { stopAllLocalRuntimes } from "../services/local-runtime-stop-all";

type SystemAppDefinition = {
  id: string;
  name: string;
  description: string;
  url: string;
  port: number;
  packageName?: string;
  accent: string;
  icon: string;
  /** "external": a page outside this computer (e.g. a claude.ai artifact); opened by URL, never started. */
  service?: "yue2" | "imaginarium" | "autonomous" | "external";
};

/** Секретарь: the owner's decision inbox — a claude.ai page over the «Решения» sheet of the agent registry. */
export const SECRETARY_URL = process.env.SECRETARY_URL ?? "https://claude.ai/artifact/H1eVbsGgwZUGksdnciKAVu";

const launcherPort = Number(process.env.LAUNCHER_PORT ?? 5172);
const studioPort = Number(process.env.STUDIO_PORT ?? 5173);
const canvasPort = Number(process.env.SNARKROUTE_PORT ?? 5174);
const brandeshmygPort = Number(process.env.BRANDESHMYG_PORT ?? 5175);
const imaginariumPort = Number(process.env.IMAGINARIUM_PORT ?? 4870);

export const systemAppCatalog: readonly SystemAppDefinition[] = [
  { id: "living-canvas", name: "Живой холст", description: "Маршруты, модели и свободная сборка", url: `http://127.0.0.1:${canvasPort}`, port: canvasPort, packageName: "@snarkroute/snarkroute", accent: "violet", icon: "/snarkroute-icon.png" },
  { id: "boojum", name: "Boojum", description: "Редактор маршрутов и узлов", url: `http://127.0.0.1:${studioPort}`, port: studioPort, packageName: "@snarkroute/studio", accent: "amber", icon: "/boojumroute-icon.png" },
  { id: "brandeshmyg", name: "Брандешмыг", description: "Инструменты как отдельные приложения", url: `http://127.0.0.1:${brandeshmygPort}`, port: brandeshmygPort, packageName: "@snarkroute/brandeshmyg", accent: "lime", icon: "/brandeshmyg-icon.png" },
  { id: "h3", name: "H3", description: "Пространственная студия", url: `http://127.0.0.1:${studioPort}/h3`, port: studioPort, packageName: "@snarkroute/studio", accent: "cyan", icon: "/h3-studio-icon.png" },
  { id: "persona", name: "Jabberwock", description: "Продолжение задач с общей памятью", url: `http://127.0.0.1:${launcherPort}/persona`, port: launcherPort, packageName: "@snarkroute/launcher", accent: "rose", icon: "/jabberwock-icon.png" },
  { id: "yue2", name: "YuE2", description: "Локальная генерация музыки", url: yue2Config.url, port: yue2Config.port, accent: "cyan", icon: "/yue2-icon.png", service: "yue2" },
  { id: "beamish", name: "Бимиш", description: "Snark’s Imaginarium · живая графика на JavaScript", url: `http://127.0.0.1:${imaginariumPort}`, port: imaginariumPort, accent: "amber", icon: "/beamish-icon.png", service: "imaginarium" },
  { id: "secretary", name: "Секретарь", description: "Вопросы агентов, которым нужен твой ответ", url: SECRETARY_URL, port: 0, accent: "amber", icon: "/secretary-icon.png", service: "external" },
  { id: "tove", name: "Шорёк", description: "Tove · проактивный агент: цели, намерения, действия", url: `http://127.0.0.1:${autonomousApps.tove.port}`, port: autonomousApps.tove.port, accent: "amber", icon: "/tove-icon.png", service: "autonomous" },
  { id: "factory", name: "Фабрика", description: "Factory · производство и продажа цифровых товаров", url: `http://127.0.0.1:${autonomousApps.factory.port}`, port: autonomousApps.factory.port, accent: "cyan", icon: "/factory-icon.png", service: "autonomous" },
  { id: "buzha", name: "Бужа", description: "Бюро разовых заказов: учёт, ручные задания и чат", url: `http://127.0.0.1:${autonomousApps.buzha.port}`, port: autonomousApps.buzha.port, accent: "lime", icon: "/buzha-icon.png", service: "autonomous" }
];
const launcherApp: SystemAppDefinition = { id: "launcher", name: "Мастерская", description: "Общий лаунчер", url: `http://127.0.0.1:${launcherPort}`, port: launcherPort, packageName: "@snarkroute/launcher", accent: "violet", icon: "sparkles" };

export async function registerSystemRoutes(app: FastifyInstance) {
  registerAutonomousApps();
  registerSystemLogProviders();
  startServiceLogMaintenance();
  const local = (request: { ip: string; hostname: string; headers: { origin?: string } }) => {
    if (appMode() !== "local" || !isLoopbackAddress(request.ip) || !isLoopbackHost(request.hostname)) return false;
    if (!request.headers.origin) return true;
    try { const origin = new URL(request.headers.origin); return origin.protocol === "http:" && isLoopbackHost(origin.hostname); } catch { return false; }
  };
  registerBuzhaModelGateway(app);
  registerModelExposureRoutes(app, local);
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
      // app.close() waits for open connections (e.g. long-lived MCP streams); the launcher gives up after 30 s,
      // so exit on our own well before that even if close never settles.
      const timer = setTimeout(() => {
        setTimeout(() => process.exit(0), 15_000).unref();
        void app.close().then(() => process.exit(0)).catch(error => { app.log.error(error); process.exit(1); });
      }, 100);
      timer.unref(); return reply.code(202).send({ ok: true });
    } catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });
  app.get("/api/system/bonsai", async (_request, reply) => {
    const state = await readBonsaiStatus();
    return reply.send({ ok: state.status !== "error", ...state });
  });

  app.post("/api/system/bonsai/start", async (_request, reply) => {
    try {
      await startLocalRuntime('bonsai');
      return reply.code(202).send({ ok: true, ...await readBonsaiStatus() });
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

  app.post("/api/system/local-runtimes/stop-all", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required." });
    const results = await stopAllLocalRuntimes();
    return { ok: true, results };
  });

  // Мастерская terminals: read-only console output of local services; no command execution.
  // Polled every second, so the requests themselves stay out of the server log.
  app.get("/api/system/local-runtimes/logs", { logLevel: "warn" }, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    const snapshot = recentLocalRuntimeSnapshot(6_000) ?? await readLocalRuntimeSnapshot();
    const beamish = await readImaginariumStatus().catch(() => undefined);
    const extras = [
      { id: "snarkroute", label: "SnarkRoute", online: true },
      { id: "beamish", label: "Beamish", ...(beamish ? { online: beamish.running } : {}) }
    ];
    return { ok: true, services: listServiceLogs([...extras, ...snapshot.runtimes]) };
  });

  app.get<{ Params: { serviceId: string }; Querystring: { source?: string; cursor?: string } }>("/api/system/local-runtimes/:serviceId/logs", { logLevel: "warn" }, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    const cursor = request.query.cursor === undefined || request.query.cursor === "" ? undefined : Number(request.query.cursor);
    try {
      return { ok: true, ...readServiceLogChunk(request.params.serviceId, String(request.query.source ?? ""), cursor) };
    } catch (error) {
      return reply.code(404).send({ ok: false, error: errorMessage(error) });
    }
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

  // SnarkBridge: start/stop go through the local runtime routes above; these add its checks, restart and logs.
  app.get("/api/system/snarkbridge", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    try { return { ok: true, ...await readSnarkBridgeStatus() }; }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });

  app.post("/api/system/snarkbridge/restart", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    try { return { ok: true, ...await restartSnarkBridge() }; }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error), status: await readSnarkBridgeStatus().catch(() => undefined) }); }
  });

  app.get("/api/system/snarkbridge/logs", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local SnarkRoute client required." });
    try { return { ok: true, ...readSnarkBridgeLogs() }; }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
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
      if (service === "external") {
        const inbox = entry.id === "secretary" ? await readSecretaryInbox() : undefined;
        return { ...entry, running: false, status: "external", generating: false, external: true,
          ...(inbox ? { pending: inbox.pending, ...(inbox.error ? { error: inbox.error } : {}) } : {}) };
      }
      if (service === "autonomous" && isAutonomousAppId(entry.id)) {
        const state = await readAutonomousAppStatus(entry.id);
        return { ...entry, running: state.running, status: state.state, mode: state.mode, current: state.current, generating: state.state === "working", error: state.error, controllable: true, ...(entry.id === "buzha" ? { automation: false } : {}) };
      }
      if (service === "imaginarium") {
        const state = await readImaginariumStatus();
        return { ...entry, running: state.running, status: state.status, generating: false, error: state.error };
      }
      const state = service === "yue2" ? await readYue2Status() : undefined;
      return { ...entry, running: state ? state.status !== "stopped" : await isPortListening(port), status: state?.status ?? (await isPortListening(port) ? "ready" : "stopped"), generating: state?.generating ?? false, error: state?.error };
    }))
  }));

  app.post<{ Params: { appId: string } }>("/api/system/apps/:appId/open", async (request, reply) => {
    const target = request.params.appId === "launcher" ? launcherApp : systemAppCatalog.find((entry) => entry.id === request.params.appId);
    if (!target) return reply.code(404).send({ ok: false, error: "Unknown local application." });
    if (target.service === "external") return { ok: true, url: target.url, started: false, status: "external" };
    if (target.service === "autonomous" && isAutonomousAppId(target.id)) {
      if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
      try {
        const before = await readAutonomousAppStatus(target.id);
        const state = await startAutonomousApp(target.id);
        return { ok: true, url: target.url, started: !before.running, status: state.state };
      } catch (error) {
        return reply.code(503).send({ ok: false, error: errorMessage(error), ...await readAutonomousAppStatus(target.id) });
      }
    }
    if (target.service === "imaginarium") {
      if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
      try {
        const before = await readImaginariumStatus();
        if (before.status === "error") return reply.code(409).send({ ok: false, error: before.error });
        if (before.status === "stopped") await startImaginarium();
        if (before.status !== "ready") await waitFor(async () => (await readImaginariumStatus()).status === "ready", 45_000, "Snark’s Imaginarium не запустился за 45 с — см. data/server.log в его папке или запустите start-imaginarium.cmd, чтобы увидеть вывод");
        return { ok: true, url: target.url, started: before.status !== "ready", status: "ready" };
      } catch (error) {
        return reply.code(503).send({ ok: false, error: errorMessage(error), ...await readImaginariumStatus() });
      }
    }
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

  app.get("/api/system/apps/beamish/status", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    return { ok: true, url: `http://127.0.0.1:${imaginariumPort}`, ...await readImaginariumStatus() };
  });

  app.post("/api/system/apps/beamish/stop", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    try {
      const before = await readImaginariumStatus();
      if (!before.running) return { ok: true, ...before };
      if (before.status === "error") return reply.code(409).send({ ok: false, error: before.error, ...before });
      // Imaginarium stops itself: its tasks are cancelled first, then the process exits.
      const response = await fetch(`http://127.0.0.1:${imaginariumPort}/api/system/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Snark’s Imaginarium не принял остановку: HTTP ${response.status}`);
      await waitFor(async () => !(await isPortListening(imaginariumPort)), 15_000, "Snark’s Imaginarium не остановился за 15 с");
      imaginariumStartedAt = 0;
      return { ok: true, ...await readImaginariumStatus() };
    } catch (error) {
      return reply.code(503).send({ ok: false, error: errorMessage(error), ...await readImaginariumStatus() });
    }
  });

  app.get<{ Params: { appId: string } }>("/api/system/apps/:appId/status", async (request, reply) => {
    if (!isAutonomousAppId(request.params.appId)) return reply.code(404).send({ ok: false, error: "Unknown autonomous application." });
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    return { ok: true, ...await readAutonomousAppStatus(request.params.appId) };
  });

  app.post<{ Params: { appId: string } }>("/api/system/apps/:appId/start", async (request, reply) => {
    if (!isAutonomousAppId(request.params.appId)) return reply.code(404).send({ ok: false, error: "Unknown autonomous application." });
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    try { return { ok: true, ...await startAutonomousApp(request.params.appId) }; }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error), ...await readAutonomousAppStatus(request.params.appId) }); }
  });

  app.post<{ Params: { appId: string } }>("/api/system/apps/:appId/stop", async (request, reply) => {
    if (!isAutonomousAppId(request.params.appId)) return reply.code(404).send({ ok: false, error: "Unknown autonomous application." });
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    try { return { ok: true, ...await stopAutonomousApp(request.params.appId) }; }
    catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error), ...await readAutonomousAppStatus(request.params.appId) }); }
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

/* On-demand dev servers: windowless, with their console output in a terminal log. */
const devServers: Record<string, { id: string; label: string; log: string }> = {
  "@snarkroute/studio": { id: "studio", label: "Boojum Studio", log: "studio-dev" },
  "@snarkroute/snarkroute": { id: "living-canvas", label: "Живой холст", log: "living-canvas-dev" },
  "@snarkroute/brandeshmyg": { id: "brandeshmyg", label: "Брандешмыг", log: "brandeshmyg-dev" },
  "@snarkroute/launcher": { id: "launcher-ui", label: "Мастерская (интерфейс)", log: "launcher-ui" }
};

function startPnpmDevServer(packageName: string, env: NodeJS.ProcessEnv) {
  const server = devServers[packageName] ?? { id: packageName, label: packageName, log: packageName.replace(/[^a-z0-9]+/gi, "-") };
  // corepack -> pnpm -> vite would each open a terminal window under a detached spawn.
  void launchBackgroundService({
    label: server.label, command: "corepack", args: ["pnpm", "--filter", packageName, "dev"], cwd: repoRoot, logPath: managedLogPath(server.log), env
  }).catch(error => console.warn(`${server.label}: ${errorMessage(error)}`));
}

function registerSystemLogProviders() {
  const managed = (id: string, title: string, log: string): ServiceLogSourceDef => ({ id, title, path: managedLogPath(log), owner: "managed" });
  registerServiceLogProvider({ id: "snarkroute", label: "SnarkRoute", order: 0, sources: () => {
    // The Mixar watchdog (Jabberwock Mixar Local) restarts SnarkRoute on its own and keeps that output itself.
    const mixarHome = localServiceHome("mixar_local");
    const mixarLog = mixarHome ? join(mixarHome, "snarkroute-autostart.log") : undefined;
    return [
      managed("server", "Сервер API (Мастерская)", "snarkroute-server"),
      ...(mixarLog && existsSync(mixarLog) ? [{ id: "mixar-autostart", title: "Автозапуск Mixar watchdog", path: mixarLog, owner: "own-file" as const }] : [])
    ];
  } });
  registerServiceLogProvider({ id: "publisher", label: "Publisher", order: 1, sources: () => [managed("server", "Project Publisher", "project-publisher")] });
  registerServiceLogProvider({ id: "beamish", label: "Beamish", order: 2, sources: () => [
    { id: "server", title: "server.log", path: join(imaginariumDir(), "data", "server.log"), owner: "own-file" },
    managed("launch", "npm start", "imaginarium-launch")
  ] });
  for (const server of Object.values(devServers)) {
    registerServiceLogProvider({ id: server.id, label: server.label, order: 80, onlyWhenPresent: true, sources: () => [managed("dev", "dev-сервер", server.log)] });
  }
  // Persona Bridge started at Windows logon by "Persona Bridge.vbs" (Startup folder) keeps this log itself.
  const personaStartupLog = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "PersonaBridge", "startup.log") : undefined;
  registerServiceLogProvider({ id: "persona-bridge", label: "Persona Bridge", order: 85, onlyWhenPresent: true, sources: () =>
    personaStartupLog ? [{ id: "startup", title: "Автозапуск Windows", path: personaStartupLog, owner: "own-file" }] : [] });
}

function startSystemApp(target: SystemAppDefinition) {
  if (!target.packageName) throw new Error("Application has no package launcher.");
  startPnpmDevServer(target.packageName, {
    ...process.env,
    ...(target.packageName === "@snarkroute/studio" ? { STUDIO_PORT: String(target.port) } : {}),
    ...(target.packageName === "@snarkroute/snarkroute" ? { SNARKROUTE_PORT: String(target.port) } : {}),
    ...(target.packageName === "@snarkroute/brandeshmyg" ? { BRANDESHMYG_PORT: String(target.port) } : {}),
    ...(target.packageName === "@snarkroute/launcher" ? { LAUNCHER_PORT: String(target.port) } : {}),
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4317}`
  });
}

/* Snark’s Imaginarium (Beamish): a separate project next to SnarkRoute, started by the Мастерская on demand. */

let imaginariumStartedAt = 0;

function imaginariumDir() {
  return process.env.IMAGINARIUM_DIR ?? join(repoRoot, "..", "snarks-imaginarium");
}

async function imaginariumHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${imaginariumPort}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json() as { ok?: boolean; service?: string };
    return response.ok && body.ok === true && body.service === "snarks-imaginarium";
  } catch {
    return false;
  }
}

export async function readImaginariumStatus(): Promise<{ status: "stopped" | "starting" | "ready" | "error"; running: boolean; error?: string }> {
  const starting = imaginariumStartedAt > 0 && Date.now() - imaginariumStartedAt < 45_000;
  if (!await isPortListening(imaginariumPort)) return { status: starting ? "starting" : "stopped", running: false };
  if (await imaginariumHealthy()) { imaginariumStartedAt = 0; return { status: "ready", running: true }; }
  return starting ? { status: "starting", running: true } : { status: "error", running: true, error: `Порт ${imaginariumPort} занят другим процессом, не Snark’s Imaginarium` };
}

async function startImaginarium() {
  const dir = imaginariumDir();
  if (!existsSync(join(dir, "package.json"))) throw new Error(`Snark’s Imaginarium не найден: ${dir}`);
  // Imaginarium writes its own data/server.log; npm's output goes to the launch log, without a window.
  // SnarkRoute's own secrets and ports are not Imaginarium's business.
  const { SNARKROUTE_LAUNCHER_TOKEN: _token, API_PORT: _apiPort, ...env } = process.env;
  imaginariumStartedAt = Date.now();
  try {
    await launchBackgroundService({
      label: "Snark’s Imaginarium", command: "npm", args: ["start"], cwd: dir, logPath: managedLogPath("imaginarium-launch"),
      env: { ...env, IMAGINARIUM_PORT: String(imaginariumPort) }
    });
  } catch (error) {
    imaginariumStartedAt = 0;
    throw error;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(message);
}

function startBoojumStudio(studioPort: string) {
  startPnpmDevServer("@snarkroute/studio", {
    ...process.env,
    STUDIO_PORT: studioPort,
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4317}`
  });
}

function startBrandeshmyg(brandeshmygPort: string) {
  startPnpmDevServer("@snarkroute/brandeshmyg", {
    ...process.env,
    BRANDESHMYG_PORT: brandeshmygPort,
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4317}`
  });
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
