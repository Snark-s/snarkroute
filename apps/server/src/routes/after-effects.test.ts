import Fastify from "fastify";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { registerAfterEffectsRoutes } from "./after-effects";

const require = createRequire(import.meta.url);
const WebSocket = require(require.resolve("ws", { paths: [dirname(require.resolve("@fastify/websocket"))] }));
const previousToken = process.env.SNARKROUTE_AE_BRIDGE_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.SNARKROUTE_AE_BRIDGE_TOKEN;
  else process.env.SNARKROUTE_AE_BRIDGE_TOKEN = previousToken;
});

describe("After Effects WebSocket route", () => {
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
