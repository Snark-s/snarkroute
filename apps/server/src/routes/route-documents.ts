import type { FastifyInstance } from "fastify";
import { basename, resolve } from "node:path";
import { parseRoute } from "@snarkroute/protocol";
import { assetsDirectory, examplesDirectory } from "../server-paths";
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
}
