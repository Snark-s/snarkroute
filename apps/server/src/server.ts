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
  void listenWithPortRetry(app, { port, host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
  return app;
}

export const LISTEN_EADDRINUSE_RETRIES = 10;
export const LISTEN_EADDRINUSE_DELAY_MS = 500;

type ListenRetryOptions = {
  port: number;
  host: string;
  retries?: number;
  delayMs?: number;
  wait?: (ms: number) => Promise<void>;
};

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

/** Give a just-shutdown process time to release the API socket before failing startup. */
export async function listenWithPortRetry(app: FastifyInstance, options: ListenRetryOptions): Promise<string> {
  const retries = options.retries ?? LISTEN_EADDRINUSE_RETRIES;
  const delayMs = options.delayMs ?? LISTEN_EADDRINUSE_DELAY_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await app.listen({ port: options.port, host: options.host });
    } catch (error) {
      if (!isAddressInUseError(error) || attempt >= retries) throw error;
      await wait(delayMs);
    }
  }
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
