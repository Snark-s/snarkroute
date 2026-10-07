import { DecisionRequestSchema, type DecisionRequest } from "@snarkroute/core";
import type { FastifyInstance } from "fastify";
import type { ServerDecisionRuntime } from "../services/decision-runtime";

export function registerDecisionRoutes(app: FastifyInstance, runtime: ServerDecisionRuntime): void {
  app.post<{ Body: unknown }>("/api/decisions", async (request, reply) => {
    const parsed = DecisionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid decision.v1 request.", issues: parsed.error.issues });
    const response = await runtime.execute(parsed.data as DecisionRequest);
    return reply.send({ ok: true, protocol: "decision.v1", response });
  });

  app.get("/api/decision-engines", async () => ({ ok: true, engines: await runtime.statuses() }));

  app.get("/api/decision-benchmarks", async () => ({ ok: true, ...runtime.benchmarkSnapshot() }));
}
