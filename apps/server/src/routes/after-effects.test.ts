import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AeBridgePairingService } from "../ae-bridge/pairing";
import { AeBridgeService } from "../ae-bridge/service";
import { createAeMcpServer } from "../mcp/server";
import { registerAfterEffectsRoutes } from "./after-effects";

const require = createRequire(import.meta.url);
const WebSocket = require(require.resolve("ws", { paths: [dirname(require.resolve("@fastify/websocket"))] }));
const previousToken = process.env.SNARKROUTE_AE_BRIDGE_TOKEN;
const previousMode = process.env.APP_MODE;

afterEach(() => {
  if (previousToken === undefined) delete process.env.SNARKROUTE_AE_BRIDGE_TOKEN;
  else process.env.SNARKROUTE_AE_BRIDGE_TOKEN = previousToken;
  if (previousMode === undefined) delete process.env.APP_MODE;
  else process.env.APP_MODE = previousMode;
});

describe("After Effects WebSocket route", () => {
  it("allows automatic pairing only for a local loopback CEP origin", async () => {
    process.env.APP_MODE = "local";
    process.env.SNARKROUTE_AE_BRIDGE_TOKEN = "permanent-fallback-must-not-leak";
    const app = Fastify();
    registerAfterEffectsRoutes(app, { bridge: new AeBridgeService(), pairing: new AeBridgePairingService() });
    await app.ready();

    const allowed = await app.inject({ method: "POST", url: "/api/ae-bridge/pair", headers: { host: "127.0.0.1:4317", origin: "null" }, remoteAddress: "127.0.0.1" });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ expiresInMs: expect.any(Number) });
    expect(allowed.json().pairingToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(allowed.json().pairingToken).not.toBe(process.env.SNARKROUTE_AE_BRIDGE_TOKEN);
    expect(allowed.headers["access-control-allow-origin"]).toBe("null");
    expect(allowed.headers["access-control-allow-origin"]).not.toBe("*");
    expect(allowed.headers["cache-control"]).toBe("no-store");

    const remote = await app.inject({ method: "POST", url: "/api/ae-bridge/pair", headers: { host: "127.0.0.1:4317", origin: "null" }, remoteAddress: "203.0.113.9" });
    expect(remote.statusCode).toBe(403);

    const hostileOrigin = await app.inject({ method: "POST", url: "/api/ae-bridge/pair", headers: { host: "127.0.0.1:4317", origin: "https://example.com" }, remoteAddress: "127.0.0.1" });
    expect(hostileOrigin.statusCode).toBe(403);
    await app.close();
  });

  it("disables automatic pairing in cloud mode", async () => {
    process.env.APP_MODE = "cloud";
    const app = Fastify(); registerAfterEffectsRoutes(app); await app.ready();
    const response = await app.inject({ method: "POST", url: "/api/ae-bridge/pair", headers: { host: "127.0.0.1:4317", origin: "null" }, remoteAddress: "127.0.0.1" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("consumes a pairing credential during WebSocket authentication", async () => {
    process.env.APP_MODE = "local";
    const bridge = new AeBridgeService(), pairing = new AeBridgePairingService();
    const app = Fastify(); registerAfterEffectsRoutes(app, { bridge, pairing });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const pair = await app.inject({ method: "POST", url: "/api/ae-bridge/pair", headers: { host: `127.0.0.1:${port}`, origin: "null" }, remoteAddress: "127.0.0.1" });
    const token = pair.json().pairingToken as string;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ae-bridge?pairingToken=${encodeURIComponent(token)}`, { origin: "null" });
    try {
      expect(JSON.parse(String((await once(socket, "message"))[0]))).toEqual({ type: "authenticated" });
      socket.send(JSON.stringify({ type: "register", sessionId: "ae-paired", host: "aftereffects", appVersion: "test", extensionVersion: "0.1.0", projectName: null, projectPath: null }));
      expect(JSON.parse(String((await once(socket, "message"))[0]))).toEqual({ type: "registered", sessionId: "ae-paired" });
      expect(bridge.listSessions()).toHaveLength(1);

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpServer = createAeMcpServer(bridge), client = new Client({ name: "pairing-smoke", version: "1" });
      await mcpServer.connect(serverTransport); await client.connect(clientTransport);
      expect(JSON.stringify(await client.callTool({ name: "ae_list_sessions", arguments: {} }))).toContain("ae-paired");
      socket.on("message", (data: unknown) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type === "execute-jsx") socket.send(JSON.stringify({ type: "execute-jsx-result", requestId: message.requestId, ok: true, result: { name: "Read-only mock comp", width: 1920, height: 1080 }, logs: [], durationMs: 1 }));
      });
      const activeComp = await client.callTool({ name: "ae_get_active_comp", arguments: {} });
      expect(JSON.stringify(activeComp)).toContain("Read-only mock comp");
      await client.close(); await mcpServer.close();

      const reused = new WebSocket(`ws://127.0.0.1:${port}/api/ae-bridge?pairingToken=${encodeURIComponent(token)}`, { origin: "null" });
      expect(JSON.parse(String((await once(reused, "message"))[0]))).toMatchObject({ type: "auth-error" });
      reused.close();
    } finally {
      socket.close();
      await once(socket, "close");
      await vi.waitFor(() => expect(bridge.listSessions()).toEqual([]));
      await app.close();
    }
  });

  it("upgrades, authenticates with the first message, and registers the session", async () => {
    process.env.SNARKROUTE_AE_BRIDGE_TOKEN = "bridge-test-token";
    const app = Fastify();
    registerAfterEffectsRoutes(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ae-bridge`);

    try {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "authenticate", token: "bridge-test-token" }));
      expect(JSON.parse(String((await once(socket, "message"))[0]))).toEqual({ type: "authenticated" });

      socket.send(JSON.stringify({ type: "register", sessionId: "ae-test", host: "aftereffects", appVersion: "test", extensionVersion: "0.1.0", projectName: null, projectPath: null }));
      expect(JSON.parse(String((await once(socket, "message"))[0]))).toEqual({ type: "registered", sessionId: "ae-test" });
    } finally {
      socket.close();
      await app.close();
    }
  });
});
