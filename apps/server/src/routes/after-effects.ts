import websocket from "@fastify/websocket";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { aeBridgeService } from "../ae-bridge/service";

export function registerAfterEffectsRoutes(app: FastifyInstance): void {
  app.register(websocket);
  const sweep = setInterval(() => aeBridgeService.expireStaleSessions(), 10_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));
  app.get("/api/ae-bridge", { websocket: true }, (connection) => {
    const socket = connection.socket;
    let authenticated = false;
    socket.on("message", (data) => {
      try {
        const text = data.toString();
        const message = JSON.parse(text) as Record<string, unknown>;
        if (!authenticated) {
          const expected = process.env.SNARKROUTE_AE_BRIDGE_TOKEN?.trim();
          const supplied = message.type === "authenticate" ? String(message.token ?? "") : "";
          if (!expected || !sameSecret(supplied, expected)) {
            socket.send(JSON.stringify({ type: "auth-error", message: expected ? "Invalid AE bridge token." : "SNARKROUTE_AE_BRIDGE_TOKEN is not configured." }));
            socket.close(1008, "Unauthorized");
            return;
          }
          authenticated = true;
          socket.send(JSON.stringify({ type: "authenticated" }));
          return;
        }
        aeBridgeService.handleMessage(socket, message);
      } catch (error) {
        socket.send(JSON.stringify({ type: "protocol-error", message: error instanceof Error ? error.message : String(error) }));
      }
    });
    socket.on("close", () => aeBridgeService.disconnect(socket));
  });
}

export function sameSecret(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
