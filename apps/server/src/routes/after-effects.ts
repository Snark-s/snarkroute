import websocket from "@fastify/websocket";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { aeBridgePairingService, type AeBridgePairingContext, type AeBridgePairingService } from "../ae-bridge/pairing";
import { aeBridgeService, type AeBridgeService } from "../ae-bridge/service";
import { appMode } from "../services/env";

type AfterEffectsRouteOptions = { bridge?: AeBridgeService; pairing?: AeBridgePairingService };

export function registerAfterEffectsRoutes(app: FastifyInstance, options: AfterEffectsRouteOptions = {}): void {
  const bridge = options.bridge ?? aeBridgeService;
  const pairing = options.pairing ?? aeBridgePairingService;
  app.register(async (scope) => {
    await scope.register(websocket);
    const sweep = setInterval(() => bridge.expireStaleSessions(), 10_000);
    sweep.unref();
    scope.addHook("onClose", async () => clearInterval(sweep));
    scope.post("/api/ae-bridge/pair", async (request, reply) => {
      if (appMode() !== "local") return reply.code(404).send({ error: "AE bridge pairing is unavailable." });
      const context = pairingContext(request.raw.socket.remoteAddress ?? request.ip, request.headers.origin);
      if (!isLoopbackAddress(context.remoteAddress) || !isLoopbackHost(request.hostname) || !isAllowedCepOrigin(context.origin)) return reply.code(403).send({ error: "AE bridge pairing is restricted to local CEP clients." });
      reply.header("Access-Control-Allow-Origin", context.origin).header("Vary", "Origin").header("Cache-Control", "no-store");
      const credential = pairing.issue(context);
      return { pairingToken: credential.token, expiresInMs: credential.expiresInMs };
    });
    scope.get("/api/ae-bridge", { websocket: true }, (connection, request) => {
      const socket = connection.socket;
      const context = pairingContext(request.raw.socket.remoteAddress ?? request.ip, request.headers.origin);
      const query = request.query as { pairingToken?: string };
      const suppliedPairingToken = typeof query.pairingToken === "string" ? query.pairingToken : "";
      let authenticated = suppliedPairingToken ? pairing.consume(suppliedPairingToken, context) : false;
      if (suppliedPairingToken) {
        if (authenticated) socket.send(JSON.stringify({ type: "authenticated" }));
        else { socket.send(JSON.stringify({ type: "auth-error", message: "Invalid or expired AE bridge pairing credential." })); socket.close(1008, "Unauthorized"); }
      }
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
          bridge.handleMessage(socket, message);
        } catch (error) {
          socket.send(JSON.stringify({ type: "protocol-error", message: error instanceof Error ? error.message : String(error) }));
        }
      });
      socket.on("close", () => bridge.disconnect(socket));
    });
  });
}

function pairingContext(remoteAddress: string, origin: string | undefined): AeBridgePairingContext { return { remoteAddress, origin: origin?.trim() ?? "" }; }
export function isLoopbackAddress(value: string): boolean { const normalized = value.trim().toLowerCase().replace(/^::ffff:/, ""); return normalized === "127.0.0.1" || normalized === "::1"; }
export function isLoopbackHost(value: string): boolean { try { const normalized = new URL(`http://${value.trim()}`).hostname.toLowerCase().replace(/^\[|\]$/g, ""); return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1"; } catch { return false; } }
export function isAllowedCepOrigin(value: string): boolean {
  if (value === "null") return true;
  try { const url = new URL(value); return url.protocol === "file:" || ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname)); }
  catch { return false; }
}

export function sameSecret(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
