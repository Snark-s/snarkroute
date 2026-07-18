import type { FastifyInstance } from "fastify";
import { CanvasActionContinuationGoneError, disposeCanvasActionSession, runCanvasActionSession } from "../libraries/service";
import type { RunCanvasActionSessionInput } from "../libraries/types";
import { errorMessage } from "../services/errors";

export async function registerCanvasActionSessionRoutes(app: FastifyInstance) {
  app.post<{ Params: { sessionId: string; actionId: string }; Body: Omit<RunCanvasActionSessionInput, "sessionId" | "actionId"> }>("/api/canvas-action-sessions/:sessionId/actions/:actionId/run", async (request, reply) => {
    try {
      if (!request.body?.input || !["image", "video", "audio", "text"].includes(request.body.input.type)) return reply.code(400).send({ error: "A supported input is required." });
      return await runCanvasActionSession({ ...request.body, sessionId: request.params.sessionId, actionId: request.params.actionId });
    } catch (error) {
      if (error instanceof CanvasActionContinuationGoneError) return reply.code(410).send({ error: errorMessage(error) });
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { sessionId: string } }>("/api/canvas-action-sessions/:sessionId", async (request) => {
    await disposeCanvasActionSession(request.params.sessionId);
    return { ok: true };
  });
}
