import type { FastifyInstance } from "fastify";
import { appDevUi, isProduction } from "../services/env";

type SwitchIdentityBody = {
  identity?: "guest" | "user" | "admin";
};

export async function registerDevRoutes(app: FastifyInstance) {
  app.post<{ Body: SwitchIdentityBody }>("/api/dev/switch-identity", async (request, reply) => {
    if (!appDevUi() || isProduction()) return reply.code(404).send({ error: "Not found." });
    const identity = request.body?.identity;
    if (identity !== "guest" && identity !== "user" && identity !== "admin") {
      return reply.code(400).send({ error: "Invalid dev identity." });
    }
    reply.header("Set-Cookie", `boojum_dev_identity=${identity}; Path=/; SameSite=Lax; Max-Age=2592000`);
    return { ok: true, identity };
  });
}
