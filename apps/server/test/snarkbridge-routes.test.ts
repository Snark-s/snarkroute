import { createServer, type Server } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Ports and a SnarkBridge home of its own: the real SnarkBridge on 8767/8080 is never touched by tests.
const sandbox = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snarkbridge-routes-"));
  const registry = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "..", "..", "service-endpoints.json"), "utf8"));
  registry.services.snarkbridge_mcp.port = 47767;
  registry.services.snarkbridge_tunnel.port = 47081;
  const registryPath = path.join(root, "service-endpoints.json");
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const home = path.join(root, "SnarkBridge");
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(home, "workspace", "scheduled-startup.log"), "Unexpected port owner PID=18848\nCONTROL_PLANE_API_KEY=sk-proj-abcdefghijklmnopq\n");
  process.env.SNARKROUTE_PORT_REGISTRY = registryPath;
  process.env.SNARKBRIDGE_HOME = home;
  process.env.SNARKBRIDGE_CONTROL_STATE_DIR = path.join(root, "state");
  return { root, home, mcpPort: 47767, tunnelPort: 47081 };
});

import { buildServer } from "../src/app";
import { resetSnarkBridgeStateForTests, setSnarkBridgeOwnerProbeForTests, type OwnerProbe } from "../src/services/snarkbridge-local";

let lastPoll = Date.now() / 1000;
const servers: Server[] = [];

function listen(port: number, handler: Parameters<typeof createServer>[0]): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}

const fakeMcp = () => listen(sandbox.mcpPort, (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/health") return res.end(JSON.stringify({ ok: true, service: "snarkbridge-mcp", apiVersion: 1, version: "1.0.0-rc1" }));
  if (req.method === "POST" && req.url === "/mcp") { res.statusCode = 401; res.setHeader("WWW-Authenticate", "Bearer"); return res.end(JSON.stringify({ error: "MCP authentication required" })); }
  res.statusCode = 404; res.end("{}");
});

const fakeTunnel = () => listen(sandbox.tunnelPort, (req, res) => {
  if (req.url === "/readyz") return res.end("ready");
  if (req.url === "/metrics") {
    return res.end([
      "commands_poll_cycles_total 4",
      `commands_poll_last_successful_timestamp_seconds ${lastPoll}`,
      `process_start_time_seconds ${Date.now() / 1000 - 600}`
    ].join("\n"));
  }
  res.statusCode = 404; res.end();
});

const owned = (port: number, pid: number): OwnerProbe => ({ port, state: "owned", pid });

describe("SnarkBridge in the Мастерская API", () => {
  const app = buildServer();

  beforeEach(() => {
    resetSnarkBridgeStateForTests();
    setSnarkBridgeOwnerProbeForTests(async () => ({ mcp: owned(sandbox.mcpPort, 101), tunnel: owned(sandbox.tunnelPort, 202) }));
  });

  afterAll(async () => {
    await Promise.all(servers.filter(server => server.listening).map(close));
    await app.close();
    setSnarkBridgeOwnerProbeForTests(undefined);
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it("reports Running, then MCP running / tunnel disconnected, through its own route and the runtime deck", async () => {
    const mcp = await fakeMcp();
    const tunnel = await fakeTunnel();
    lastPoll = Date.now() / 1000 - 5;

    const running = (await app.inject({ method: "GET", url: "/api/system/snarkbridge" })).json();
    expect(running).toMatchObject({ ok: true, status: "running", running: true, control: { canStop: true, canStart: false } });
    expect(running.checks.mcpEndpoint.detail).toMatch(/\/health и \/mcp отвечают/);
    expect(running.checks.external.state).toBe("unknown");

    lastPoll = Date.now() / 1000 - 600;
    const degraded = (await app.inject({ method: "GET", url: "/api/system/snarkbridge" })).json();
    expect(degraded.status).toBe("degraded");
    expect(degraded.summary).toMatch(/туннель без связи с OpenAI/);
    const deck = (await app.inject({ method: "GET", url: "/api/system/local-runtimes" })).json();
    expect(deck.runtimes.find((runtime: { id: string }) => runtime.id === "snarkbridge")).toMatchObject({
      label: "SnarkBridge", state: "error", online: true, resourceClaim: "none", control: { canStart: true, canStop: true }
    });

    await close(tunnel);
    const noTunnel = (await app.inject({ method: "GET", url: "/api/system/snarkbridge" })).json();
    expect(noTunnel).toMatchObject({ status: "degraded", summary: "MCP работает · туннель не запущен" });
    await close(mcp);
  }, 30_000);

  it("refuses start and stop without changing anything when a port owner cannot be verified", async () => {
    const mcp = await fakeMcp();
    const tunnel = await fakeTunnel();
    setSnarkBridgeOwnerProbeForTests(async () => ({ mcp: owned(sandbox.mcpPort, 101), tunnel: { port: sandbox.tunnelPort, state: "unverified", pid: 18848, name: "tunnel-client.exe" } }));

    const stop = await app.inject({ method: "POST", url: "/api/system/local-runtimes/snarkbridge/stop", payload: {} });
    expect(stop.statusCode).toBe(503);
    expect(stop.json().error).toMatch(/PID 18848/);
    const start = await app.inject({ method: "POST", url: "/api/system/local-runtimes/snarkbridge/start", payload: { force: false } });
    expect(start.statusCode).toBe(503);
    expect(existsSync(join(sandbox.home, ".owner-stopped.json"))).toBe(false);
    await Promise.all([close(mcp), close(tunnel)]);
  }, 30_000);

  it("Stop records the owner's intent for the Watchdog; a stopped SnarkBridge stays stopped", async () => {
    const stop = await app.inject({ method: "POST", url: "/api/system/local-runtimes/snarkbridge/stop", payload: {} });
    expect(stop.statusCode).toBe(200);
    expect(existsSync(join(sandbox.home, ".owner-stopped.json"))).toBe(true);
    const state = (await app.inject({ method: "GET", url: "/api/system/snarkbridge" })).json();
    expect(state).toMatchObject({ status: "stopped", ownerStopped: true, control: { canStart: true, canStop: false } });
    expect(state.summary).toMatch(/Watchdog не запустит/);
  }, 30_000);

  it("serves recent logs with secrets hidden, and only to local clients", async () => {
    const logs = (await app.inject({ method: "GET", url: "/api/system/snarkbridge/logs" })).json();
    const watchdog = logs.sources.find((source: { id: string }) => source.id === "watchdog");
    expect(watchdog.text).toMatch(/Unexpected port owner PID=18848/);
    expect(JSON.stringify(logs)).not.toMatch(/abcdefghijklmnopq/);
    const foreign = await app.inject({ method: "GET", url: "/api/system/snarkbridge", headers: { origin: "https://example.com" } });
    expect(foreign.statusCode).toBe(403);
  });
});
