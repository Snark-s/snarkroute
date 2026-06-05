import type { FastifyInstance } from "fastify";
import { generateMarbleWorld, getMarbleOperation, getMarbleWorld } from "../services/worldlabs-marble";

export async function registerWorldLabsMarbleRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      imageUrl?: string;
      imagePath?: string;
      isPano?: boolean;
      model?: string;
      displayName?: string;
      sourceImageHash?: string;
    };
  }>("/api/worldlabs/marble/generate", async (request, reply) => {
    try {
      return await generateMarbleWorld(request.body ?? {});
    } catch (error) {
      return reply.code(statusForWorldLabsError(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/worldlabs/marble/operations/:id", async (request, reply) => {
    try {
      return await getMarbleOperation(request.params.id);
    } catch (error) {
      return reply.code(statusForWorldLabsError(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/worldlabs/marble/worlds/:id", async (request, reply) => {
    try {
      return await getMarbleWorld(request.params.id);
    } catch (error) {
      return reply.code(statusForWorldLabsError(error)).send({ error: errorMessage(error) });
    }
  });
}

function statusForWorldLabsError(error: unknown): number {
  const message = errorMessage(error);
  if (/API key is not configured/i.test(message)) return 400;
  if (/requires|must be|did not include/i.test(message)) return 422;
  return 502;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
