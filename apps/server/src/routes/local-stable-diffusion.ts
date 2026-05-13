import type { FastifyInstance } from "fastify";
import { fetchWithTimeout } from "../services/http";
import { normalizeStableDiffusionModels, trimTrailingSlash } from "../services/local-stable-diffusion";

export async function registerLocalStableDiffusionRoutes(app: FastifyInstance) {
app.get<{ Querystring: { endpoint?: string } }>("/api/local-stable-diffusion/models", async (request, reply) => {
  const endpoint = trimTrailingSlash(request.query.endpoint?.trim() || "http://127.0.0.1:7860");
  try {
    const response = await fetchWithTimeout(`${endpoint}/sdapi/v1/sd-models`, 5000);
    if (response.status === 404) return reply.code(404).send({ error: "Stable Diffusion WebUI API endpoint is not available. Make sure API mode is enabled." });
    const text = await response.text();
    if (!response.ok) return reply.code(response.status).send({ error: `Stable Diffusion WebUI model list failed (${response.status}).` });
    const models = JSON.parse(text) as unknown;
    return { endpoint, models: normalizeStableDiffusionModels(models) };
  } catch (error) {
    return reply.code(400).send({ error: `Local Stable Diffusion server is not reachable at ${endpoint}` });
  }
});

}
