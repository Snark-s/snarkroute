import cors from "@fastify/cors";
import dotenv from "dotenv";
import Fastify from "fastify";
import { readFile, writeFile } from "node:fs/promises";
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
const envPath = join(process.cwd(), ".env");

export function buildServer() {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  app.get("/api/health", async () => ({ ok: true, app: "snarkroute", replicateEnabled: isReplicateEnabled() }));

  app.get("/api/settings", async () => ({ replicateConfigured: isReplicateEnabled() }));

  app.post<{ Body: { replicateApiToken?: string } }>("/api/settings/replicate-token", async (request, reply) => {
    const token = request.body?.replicateApiToken?.trim();
    if (!token) return reply.code(400).send({ error: "REPLICATE_API_TOKEN cannot be empty." });
    try {
      await writeEnvValue("REPLICATE_API_TOKEN", token);
      process.env.REPLICATE_API_TOKEN = token;
      return { ok: true, replicateConfigured: true };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/nodes", async () => ({
    nodes: [
      ...builtInNodeDefinitions,
      { type: "replicate.model", title: "Replicate Model", description: "Runs a Replicate model prediction.", enabled: isReplicateEnabled() }
    ]
  }));

  app.get<{ Querystring: { model?: string } }>("/api/replicate/schema", async (request, reply) => {
    if (!isReplicateEnabled()) return reply.code(400).send({ error: "REPLICATE_API_TOKEN is not configured." });
    if (!request.query.model) return reply.code(400).send({ error: "Query parameter model is required." });
    try {
      return await createReplicateClient().getModelSchema(request.query.model);
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
      if (isReplicateEnabled()) executor.registerNodeRunner("replicate.model", createReplicateNodeRunner());
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

function isReplicateEnabled(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN?.trim());
}

async function writeEnvValue(key: string, value: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    text = "";
  }

  const escaped = value.replace(/\r?\n/g, "");
  const line = `${key}=${escaped}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.trimEnd()}${text.trimEnd() ? "\n" : ""}${line}\n`;

  await writeFile(envPath, next, "utf8");
}

if (process.env.SNARKROUTE_NO_LISTEN !== "1") {
  const app = buildServer();
  app.listen({ port, host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
