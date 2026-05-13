import type { FastifyInstance } from "fastify";
import { readLedgerRuns, summarizeLedgerRuns } from "../ledger/service";

export async function registerLedgerRoutes(app: FastifyInstance) {
app.get<{ Querystring: { limit?: string } }>("/api/ledger/runs", async (request) => {
  const limit = Math.min(Number(request.query.limit ?? 100), 500);
  const runs = await readLedgerRuns();
  return { runs: runs.slice(-limit).reverse() };
});

app.get<{ Params: { runId: string } }>("/api/ledger/runs/:runId", async (request, reply) => {
  const runs = await readLedgerRuns();
  const run = runs.find((entry) => entry.runId === request.params.runId);
  if (!run) return reply.code(404).send({ error: `Ledger run "${request.params.runId}" was not found.` });
  return run;
});

app.get("/api/ledger/summary", async () => summarizeLedgerRuns(await readLedgerRuns()));
}
