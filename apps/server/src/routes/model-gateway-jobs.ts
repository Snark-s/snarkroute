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
      const headerKey = firstHeader(request.headers["idempotency-key"]);
      return { ok: true, job: await modelGatewayJobService.create({ ...request.body, idempotencyKey: request.body.idempotencyKey ?? headerKey }) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/model-gateway/jobs/:id", async (request, reply) => {
    const job = await modelGatewayJobService.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "Generation job not found." });
    const resultUrl = job.status === "completed" ? `/api/model-gateway/jobs/${encodeURIComponent(job.id)}/result` : null;
    return { ok: true, job: { ...job, resultUrl, outputs: job.outputs?.map((output) => ({ ...output, path: undefined, resultUrl: `${resultUrl}?index=${output.index}` })) } };
  });

  app.post<{ Params: { id: string } }>("/api/model-gateway/jobs/:id/cancel", async (request, reply) => {
    const job = await modelGatewayJobService.cancel(request.params.id);
    if (!job) return reply.code(404).send({ error: "Generation job not found." });
    return { ok: true, job };
  });

  app.post<{ Params: { id: string }; Body: { idempotencyKey?: string } }>("/api/model-gateway/jobs/:id/retry", async (request, reply) => {
    try {
      const job = await modelGatewayJobService.retry(request.params.id, request.body?.idempotencyKey ?? firstHeader(request.headers["idempotency-key"]));
      if (!job) return reply.code(404).send({ error: "Generation job not found." });
      return { ok: true, job };
    } catch (error) {
      return reply.code(409).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: { index?: number } }>("/api/model-gateway/jobs/:id/select-result", async (request, reply) => {
    try {
      const job = await modelGatewayJobService.selectOutput(request.params.id, Number(request.body?.index ?? 0));
      if (!job) return reply.code(404).send({ error: "Generation job not found." });
      return { ok: true, job };
    } catch (error) {
      return reply.code(409).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { index?: string } }>("/api/model-gateway/jobs/:id/result", async (request, reply) => {
    try {
      const job = await modelGatewayJobService.get(request.params.id);
      if (!job) return reply.code(404).send({ error: "Generation job not found." });
      const index = Math.max(0, Number.parseInt(request.query.index ?? "0", 10) || 0);
      const output = job.outputs?.[index];
      const descriptor = output ?? (index === 0 ? job.result : undefined);
      if (!descriptor) return reply.code(409).send({ error: "Generation result is not ready." });
      await access(descriptor.path);
      reply.header("Content-Type", descriptor.mimeType);
      reply.header("Content-Disposition", `attachment; filename="${descriptor.filename.replace(/[\r\n"]/g, "_")}"`);
      return reply.send(modelGatewayJobService.resultStream(job, index));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
