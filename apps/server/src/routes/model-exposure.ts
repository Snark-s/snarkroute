import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModelCatalogEntryV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { errorMessage } from "../services/errors";
import { groupModelExposure, modelExposureEntries, modelExposureSummary, readModelExposurePolicy, writeModelExposurePolicy, type ModelExposurePolicy } from "../services/model-exposure";
import { loadLiveModelCatalogV1 } from "./models";

type Deps = { catalog: () => Promise<ModelCatalogEntryV1[]>; read: () => Promise<ModelExposurePolicy>; write: (value: unknown) => Promise<ModelExposurePolicy> };
const defaultDeps: Deps = { catalog: () => loadLiveModelCatalogV1(), read: () => readModelExposurePolicy(), write: value => writeModelExposurePolicy(value) };

export async function modelExposureView(policy: ModelExposurePolicy, catalog: ModelCatalogEntryV1[]) {
  const entries = modelExposureEntries(catalog, policy);
  return { ok: true, policy, summary: modelExposureSummary(entries), groups: groupModelExposure(entries, policy) };
}

/** Workshop «Система» → «Модели и провайдеры»: the full catalog by type plus what other networks receive. */
export function registerModelExposureRoutes(app: FastifyInstance, local: (request: FastifyRequest) => boolean, deps: Deps = defaultDeps): void {
  app.get("/api/system/model-exposure", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    try {
      const [policy, catalog] = await Promise.all([deps.read(), deps.catalog()]);
      return reply.header("cache-control", "no-store").send(await modelExposureView(policy, catalog));
    } catch (error) { return reply.code(503).send({ ok: false, error: errorMessage(error) }); }
  });

  app.put("/api/system/model-exposure", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Local launcher client required" });
    try {
      const policy = await deps.write(request.body);
      return reply.header("cache-control", "no-store").send(await modelExposureView(policy, await deps.catalog()));
    } catch (error) { return reply.code(500).send({ ok: false, error: errorMessage(error) }); }
  });
}
