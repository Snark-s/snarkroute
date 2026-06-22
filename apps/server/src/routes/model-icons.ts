import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { modelIconsDirectory } from "../server-paths";

const safeIconFilename = /^[a-z0-9][a-z0-9._-]*\.(svg|png|webp|jpg|jpeg)$/i;

export async function registerModelIconRoutes(app: FastifyInstance) {
app.addHook("onRequest", async (request, reply) => {
  if (request.method !== "GET") return;
  const url = new URL(request.url, "http://localhost");
  const prefix = "/api/model-icons/";
  if (!url.pathname.startsWith(prefix)) return;
  try {
    const rawIcon = decodeURIComponent(url.pathname.slice(prefix.length));
    const icon = basename(rawIcon);
    if (icon !== rawIcon || !safeIconFilename.test(icon)) return reply.code(404).send({ error: "Model icon not found." });
    const path = join(modelIconsDirectory, icon);
    await access(path);
    reply.header("Cache-Control", "no-cache");
    reply.header("Content-Type", modelIconContentType(icon));
    return reply.send(createReadStream(path));
  } catch {
    return reply.code(404).send({ error: "Model icon not found." });
  }
});
}

function modelIconContentType(filename: string): string {
  if (/\.svg$/i.test(filename)) return "image/svg+xml";
  if (/\.webp$/i.test(filename)) return "image/webp";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  return "image/png";
}
