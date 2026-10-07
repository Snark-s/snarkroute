import { buildServer } from "./app";
import type { FastifyInstance } from "fastify";
export const port = Number(process.env.API_PORT ?? 4317);
export const host = process.env.HOST ?? "127.0.0.1";
export function startServer() {
  const app = buildServer();
  if (!attachLauncherLifetime(app)) return app;
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
