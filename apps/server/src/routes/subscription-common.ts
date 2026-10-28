import type { FastifyRequest } from "fastify";
import { isLoopbackAddress, isLoopbackHost } from "./after-effects";

/** The owner's subscriptions answer only loopback clients (no browser origin from elsewhere). */
export function isLocalClient(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.ip) || !isLoopbackHost(request.hostname)) return false;
  if (!request.headers.origin) return true;
  try { const url = new URL(request.headers.origin); return url.protocol === "http:" && isLoopbackHost(url.hostname); }
  catch { return false; }
}
