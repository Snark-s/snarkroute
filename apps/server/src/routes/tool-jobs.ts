import type { FastifyInstance } from "fastify";
import { appMode } from "../services/env";
import { errorMessage } from "../services/errors";
import { portableToolJobService, type PortableToolJobRequest } from "../tool-jobs/service";
import { h3RegenerationService } from "../h3-regeneration/service";

export async function registerPortableToolJobRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: Omit<PortableToolJobRequest, "toolId"> }>("/api/tools/:id/jobs", async (request, reply) => {
    if (appMode() === "cloud") return reply.code(404).send({ error: "Local portable tool jobs are unavailable in cloud mode." });
    try {
      const header = request.headers["idempotency-key"];
      const idempotencyKey = request.body?.idempotencyKey ?? (Array.isArray(header) ? header[0] : header);
      return { ok: true, job: await portableToolJobService.create({ ...request.body, toolId: request.params.id, idempotencyKey }) };
    } catch (error) { return reply.code(400).send({ ok: false, error: errorMessage(error) }); }
  });
  app.get<{ Params: { id: string } }>("/api/tool-jobs/:id", async (request, reply) => {
    const job = await portableToolJobService.get(request.params.id);
    return job ? { ok: true, job } : reply.code(404).send({ error: "Portable tool job not found." });
  });
  app.post<{ Params: { id: string } }>("/api/tool-jobs/:id/cancel", async (request, reply) => {
    const job = await portableToolJobService.cancel(request.params.id);
    return job ? { ok: true, job } : reply.code(404).send({ error: "Portable tool job not found." });
  });
  app.post<{ Params: { id: string }; Body: { resultId?: string } }>("/api/tool-jobs/:id/select-result", async (request, reply) => {
    try {
      const job = await portableToolJobService.select(request.params.id, request.body?.resultId ?? "");
      return job ? { ok: true, job } : reply.code(404).send({ error: "Portable tool job not found." });
    } catch (error) { return reply.code(409).send({ ok: false, error: errorMessage(error) }); }
  });
  app.get<{ Querystring: { duration?: string } }>("/api/h3-regeneration/availability", async (request, reply) => {
    try { return { ok: true, ...h3RegenerationService.availability(Number(request.query.duration ?? 5)) }; }
    catch (error) { return reply.code(400).send({ ok: false, error: errorMessage(error) }); }
  });
  app.post<{ Params: { id: string }; Body: { resultId?: string; idempotencyKey?: string } }>("/api/tool-jobs/:id/regenerate-2k", async (request, reply) => {
    try {
      const header = request.headers["idempotency-key"], idempotencyKey = request.body?.idempotencyKey ?? (Array.isArray(header) ? header[0] : header);
      return { ok: true, job: await h3RegenerationService.create({ sourceToolJobId: request.params.id, resultId: request.body?.resultId, idempotencyKey }) };
    } catch (error) { return reply.code(409).send({ ok: false, error: errorMessage(error) }); }
  });
  app.get<{ Params: { id: string } }>("/api/h3-regeneration-jobs/:id", async (request, reply) => {
    const job = await h3RegenerationService.get(request.params.id);
    return job ? { ok: true, job } : reply.code(404).send({ error: "H3 regeneration job not found." });
  });
  app.post<{ Params: { id: string } }>("/api/h3-regeneration-jobs/:id/cancel", async (request, reply) => {
    const job = await h3RegenerationService.cancel(request.params.id);
    return job ? { ok: true, job } : reply.code(404).send({ error: "H3 regeneration job not found." });
  });
}
