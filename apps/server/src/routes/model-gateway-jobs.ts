import type { FastifyInstance } from "fastify";
import { access } from "node:fs/promises";
import type { GenerationJobRequest } from "../model-gateway-jobs/service";
import { modelGatewayJobService } from "../model-gateway-jobs/service";
import { appMode } from "../services/env";
import { errorMessage } from "../services/errors";

export async function registerModelGatewayJobRoutes(app: FastifyInstance) {
  app.post<{ Body: GenerationJobRequest }>("/api/model-gateway/jobs", async (request, reply) => {
    if (appMode() === "cloud") return reply.code(404).send({ error: "Local generation jobs are unavailable in cloud mode." });
    try {
      return { ok: true, job: await modelGatewayJobService.create(request.body) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/model-gateway/jobs/:id", async (request, reply) => {
    const job = await modelGatewayJobService.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "Generation job not found." });
    return { ok: true, job: { ...job, resultUrl: job.status === "completed" ? `/api/model-gateway/jobs/${encodeURIComponent(job.id)}/result` : null } };
  });

  app.get<{ Params: { id: string } }>("/api/model-gateway/jobs/:id/result", async (request, reply) => {
    try {
      const job = await modelGatewayJobService.get(request.params.id);
      if (!job) return reply.code(404).send({ error: "Generation job not found." });
      if (!job.result) return reply.code(409).send({ error: "Generation result is not ready." });
      await access(job.result.path);
      reply.header("Content-Type", job.result.mimeType);
      reply.header("Content-Disposition", `attachment; filename="${job.result.filename.replace(/[\r\n"]/g, "_")}"`);
      return reply.send(modelGatewayJobService.resultStream(job));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}
