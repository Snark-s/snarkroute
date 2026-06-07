import { writeFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { basename, resolve } from "node:path";
import { exportRouteToText, loadRouteFromText, parseRoute } from "@snarkroute/protocol";
import { assetsDirectory, examplesDirectory, startupRoutePath } from "../server-paths";
import { appMode } from "../services/env";
import { getAuthAdapter } from "../auth/adapters";
import { getCloudStorage } from "../services/cloud-storage";
import { errorMessage } from "../services/errors";
import { isDemoSafeRoute } from "./demo-routes";
import { listRouteFiles, loadExampleRoute } from "./route-files";

export async function registerRouteDocumentRoutes(app: FastifyInstance) {
app.get("/api/routes/examples", async () => {
  const files = await listRouteFiles(examplesDirectory);
  return {
    routes: await Promise.all(
      files.map(async (file) => {
        const route = parseRoute(await loadExampleRoute(file));
        return { id: route.route.id, title: route.route.title, description: route.route.description, filename: basename(file), path: file, demoSafe: isDemoSafeRoute(route) };
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

app.get("/api/routes/saved", async (request, reply) => {
  if (appMode() === "cloud") {
    try {
      const user = await getAuthAdapter().requireUser(request);
      return { routes: await getCloudStorage().listRoutes(user.id) };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  }

  const files = await listRouteFiles(assetsDirectory);
  return { routes: files.map((file) => ({ filename: basename(file), path: file })) };
});

app.get<{ Params: { id: string } }>("/api/routes/saved/:id", async (request, reply) => {
  if (appMode() !== "cloud") return reply.code(404).send({ error: "Saved route loading by id is only available in cloud mode." });
  try {
    const user = await getAuthAdapter().requireUser(request);
    const route = await getCloudStorage().loadRoute(request.params.id, user.id);
    if (!route) return reply.code(404).send({ error: "Route not found." });
    return { ok: true, route };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});

app.delete<{ Params: { id: string } }>("/api/routes/saved/:id", async (request, reply) => {
  if (appMode() !== "cloud") return reply.code(404).send({ error: "Saved route deletion by id is only available in cloud mode." });
  try {
    const user = await getAuthAdapter().requireUser(request);
    const deleted = await getCloudStorage().deleteRoute(request.params.id, user.id);
    return { ok: true, deleted };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { text?: string; filename?: string } }>("/api/routes", async (request, reply) => {
  if (appMode() !== "cloud") return reply.code(404).send({ error: "Cloud route storage is only available in cloud mode." });
  return saveCloudRoute(request.body?.text, request.body?.filename ?? "studio-route.orp.json", request, reply);
});

app.post<{ Body: { text?: string; filename?: string } }>("/api/routes/startup", async (request, reply) => {
  try {
    const text = request.body?.text;
    const filename = request.body?.filename ?? "startup-route.orp.json";
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "Route text is required." });
    const route = loadRouteFromText(text, filename);
    if (appMode() === "cloud") return saveCloudRoute(text, filename, request, reply);
    const serialized = exportRouteToText(route, "default-route.orp.json");
    await writeFile(startupRoutePath, serialized, "utf8");
    return { ok: true, path: startupRoutePath, route: parseRoute(route).route };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});
}

async function saveCloudRoute(text: unknown, filename: string, request: FastifyRequest, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  try {
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "Route text is required." });
    const routeDocument = loadRouteFromText(text, filename);
    const parsed = parseRoute(routeDocument);
    const serialized = exportRouteToText(routeDocument, filename);
    const saved = await getCloudStorage().saveRoute({
      routeKey: parsed.route.id || "studio-route",
      title: parsed.route.title,
      description: parsed.route.description,
      routeDocument,
      routeText: serialized,
      ownerUserId: (await getAuthAdapter().requireUser(request)).id
    });
    return { ok: true, route: saved };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
}
