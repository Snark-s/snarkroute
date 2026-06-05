import type { FastifyInstance } from "fastify";
import { parseRoute } from "@snarkroute/protocol";
import { getAuthAdapter } from "../auth/adapters";
import { getBillingAdapter } from "../billing/adapters";
import { errorMessage } from "../services/errors";

export async function registerBillingRoutes(app: FastifyInstance) {
  app.get("/api/billing/balance", async (request, reply) => {
    try {
      const user = await getAuthAdapter().requireUser(request);
      return await getBillingAdapter().getBalance(user.id);
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/billing/estimate", async (request, reply) => {
    try {
      const route = parseRoute(request.body);
      const estimate = await getBillingAdapter().estimateRunCost(route);
      return estimate;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}
