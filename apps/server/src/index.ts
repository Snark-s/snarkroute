import cors from "@fastify/cors";
import dotenv from "dotenv";
import Fastify from "fastify";
import { join } from "node:path";
import { createExecutor } from "@snarkroute/executor";
import { builtInNodeDefinitions, registerBuiltInNodeRunners } from "@snarkroute/nodes";
import { parseRoute, validateRoute } from "@snarkroute/protocol";
import { createReplicateClient, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createLocalRunStorage } from "@snarkroute/storage";

dotenv.config();

const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";
const storage = createLocalRunStorage(join(process.cwd(), "data", "runs"));
const replicateEnabled = Boolean(process.env.REPLICATE_API_TOKEN);
const replicateClient = createReplicateClient();

export function buildServer() {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  app.get("/api/health", async () => ({ ok: true, app: "snarkroute", replicateEnabled }));

  app.get("/api/nodes", async () => ({
    nodes: [
      ...builtInNodeDefinitions,
      { type: "replicate.model", title: "Replicate Model", description: "Runs a Replicate model prediction.", enabled: replicateEnabled }
    ]
  }));

  app.get<{ Querystring: { model?: string } }>("/api/replicate/schema", async (request, reply) => {
    if (!replicateEnabled) return reply.code(400).send({ error: "REPLICATE_API_TOKEN is not configured." });
    if (!request.query.model) return reply.code(400).send({ error: "Query parameter model is required." });
    try {
      return await replicateClient.getModelSchema(request.query.model);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/routes/validate", async (request) => validateRoute(request.body));

  app.post("/api/routes/run", async (request, reply) => {
    try {
      const route = parseRoute(request.body);
      const executor = createExecutor();
      registerBuiltInNodeRunners(executor);
      if (replicateEnabled) executor.registerNodeRunner("replicate.model", createReplicateNodeRunner());
      const runId = `run_${Date.now()}`;
      const outputDirectory = await storage.createRunDirectory(runId);
      return await executor.executeRoute(route, { runId, outputDirectory });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    try {
      return await storage.readRunResult(request.params.runId);
    } catch {
      return reply.code(404).send({ error: `Run "${request.params.runId}" was not found.` });
    }
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.env.SNARKROUTE_NO_LISTEN !== "1") {
  const app = buildServer();
  app.listen({ port, host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
