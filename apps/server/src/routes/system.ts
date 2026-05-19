import type { FastifyInstance } from "fastify";
import { errorMessage } from "../services/errors";
import { readSystemUpdateStatus, updateFromGitHub } from "../services/system-update";

export async function registerSystemRoutes(app: FastifyInstance) {
  app.get("/api/system/update/status", async (request, reply) => {
    try {
      return await readSystemUpdateStatus();
    } catch (error) {
      return reply.code(500).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/system/update", async (request, reply) => {
    try {
      return await updateFromGitHub();
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });
}
