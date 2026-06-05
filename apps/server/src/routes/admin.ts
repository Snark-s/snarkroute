import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/adapters";
import { getCloudStorage } from "../services/cloud-storage";
import { isGeminiEnabled, isOpenAiEnabled, isOpenRouterEnabled, isPolzaEnabled, isReplicateEnabled, isSeedanceEnabled } from "../services/env";
import { errorMessage } from "../services/errors";

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/admin/overview", async (_request, reply) => {
    try {
      await requireAdmin(_request);
      const overview = await getCloudStorage().adminOverview();
      return {
        ...overview,
        providerKeyStatus: {
          openrouter: isOpenRouterEnabled(),
          polza: isPolzaEnabled(),
          replicate: isReplicateEnabled(),
          gemini: isGeminiEnabled(),
          openai: isOpenAiEnabled(),
          seedance: isSeedanceEnabled()
        }
      };
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });
}
