import { buildServer } from "./app";
import type { FastifyInstance } from "fastify";
import { localServicePort } from "./services/local-service-endpoints";
import { attachSentinel } from "./services/sentinel-runtime";
// Local mode has one port authority. API_PORT may only confirm, never override it.
const declaredPort = localServicePort("snarkroute");
if (process.env.API_PORT?.trim() && Number(process.env.API_PORT) !== declaredPort) {
  throw new Error("API_PORT conflicts with SnarkRoute service-endpoints.json");
}
export const port = declaredPort;
if (process.env.HOST?.trim() && process.env.HOST.trim() !== "127.0.0.1") {
  throw new Error("HOST conflicts with SnarkRoute loopback service registry");
}
export const host = "127.0.0.1";
export function startServer() {
  const app = buildServer();
  if (!attachLauncherLifetime(app)) return app;
  attachSentinel(app);
  app.listen({ port, host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
  return app;
}
/** Owned API processes close their existing jobs/routes if the launcher dies. */
export function attachLauncherLifetime(app: FastifyInstance, channel = process): boolean {
  if (!process.env.SNARKROUTE_LAUNCHER_TOKEN || !channel.send) return true;
  let closing = false;
  const disconnect = () => {
    if (closing) return; closing = true;
    void app.close().then(() => channel.exit(0)).catch(error => app.log.error(error));
  };
  channel.once("disconnect", disconnect);
  channel.once("SIGINT", disconnect); channel.once("SIGTERM", disconnect);
  app.addHook("onClose", async () => {
    channel.off("disconnect", disconnect); channel.off("SIGINT", disconnect); channel.off("SIGTERM", disconnect);
  });
  if (!channel.connected) { disconnect(); return false; }
  return true;
}
