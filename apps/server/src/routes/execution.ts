import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { builtInNodeManifests, loadInstalledNodeManifests, validatePromptLibraryNodes, validateRouteNodeTypes } from "@snarkroute/nodes";
import { parseRoute, validateRoute } from "@snarkroute/protocol";
import { createLocalRunStorage } from "@snarkroute/storage";
import { createRouteExecutor } from "../execution/service";
import { providerNodeManifests } from "../providers/provider-node-manifests";
import { errorMessage } from "../services/errors";

const storage = createLocalRunStorage(join(process.cwd(), "data", "runs"));

export async function registerExecutionRoutes(app: FastifyInstance) {
app.post("/api/routes/validate", async (request) => {
  const validation = validateRoute(request.body);
  if (!validation.ok || !validation.route) return validation;
  const promptIssues = await validatePromptLibraryNodes(validation.route.nodes);
  const nodeTypeIssues = await validateRouteNodeTypes(validation.route.nodes, [...builtInNodeManifests, ...providerNodeManifests(), ...(await loadInstalledNodeManifests())]);
  const issues = [...promptIssues, ...nodeTypeIssues];
  return {
    ok: issues.length === 0,
    route: issues.length === 0 ? validation.route : undefined,
    issues
  };
});

app.post<{ Body: { route?: unknown; initialNodeOutputs?: Record<string, unknown> } }>("/api/routes/run", async (request, reply) => {
  try {
    const routeInput = request.body && typeof request.body === "object" && "routeVersion" in request.body ? request.body : request.body?.route;
    const route = parseRoute(routeInput);
    const executor = await createRouteExecutor();
    const runId = `run_${Date.now()}`;
    const outputDirectory = await storage.createRunDirectory(runId);
    return await executor.executeRoute(route, { runId, outputDirectory, initialNodeOutputs: request.body?.initialNodeOutputs });
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});
}

export async function registerRunResultRoutes(app: FastifyInstance) {
app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
  try {
    return await storage.readRunResult(request.params.runId);
  } catch {
    return reply.code(404).send({ error: `Run "${request.params.runId}" was not found.` });
  }
});
}

