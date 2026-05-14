import { writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { basename, resolve } from "node:path";
import { exportRouteToText, loadRouteFromText, parseRoute } from "@snarkroute/protocol";
import { assetsDirectory, examplesDirectory, startupRoutePath } from "../server-paths";
import { errorMessage } from "../services/errors";
import { listRouteFiles, loadExampleRoute } from "./route-files";

export async function registerRouteDocumentRoutes(app: FastifyInstance) {
app.get("/api/routes/examples", async () => {
  const files = await listRouteFiles(examplesDirectory);
  return {
    routes: await Promise.all(
      files.map(async (file) => {
        const route = parseRoute(await loadExampleRoute(file));
        return { id: route.route.id, title: route.route.title, description: route.route.description, filename: basename(file), path: file };
      })
    )
  };
});

app.get<{ Params: { filename: string } }>("/api/routes/examples/:filename", async (request, reply) => {
  try {
    const file = resolve(examplesDirectory, request.params.filename);
    if (!file.startsWith(resolve(examplesDirectory))) return reply.code(400).send({ error: "Invalid example route path." });
    return await loadExampleRoute(file);
  } catch (error) {
    return reply.code(404).send({ error: errorMessage(error) });
  }
});

app.get("/api/routes/saved", async () => {
  const files = await listRouteFiles(assetsDirectory);
  return { routes: files.map((file) => ({ filename: basename(file), path: file })) };
});

app.post<{ Body: { text?: string; filename?: string } }>("/api/routes/startup", async (request, reply) => {
  try {
    const text = request.body?.text;
    const filename = request.body?.filename ?? "startup-route.orp.json";
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "Route text is required." });
    const route = loadRouteFromText(text, filename);
    const serialized = exportRouteToText(route, "default-route.orp.json");
    await writeFile(startupRoutePath, serialized, "utf8");
    return { ok: true, path: startupRoutePath, route: parseRoute(route).route };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});
}
