import type { FastifyInstance } from "fastify";
import { fetchWithTimeout } from "../services/http";
import { normalizeComfyUiModels, normalizeStableDiffusionModels, trimTrailingSlash } from "../services/local-stable-diffusion";

export async function registerLocalStableDiffusionRoutes(app: FastifyInstance) {
app.get<{ Querystring: { endpoint?: string; providerType?: string } }>("/api/local-stable-diffusion/models", async (request, reply) => {
  const endpoint = trimTrailingSlash(request.query.endpoint?.trim() || "http://127.0.0.1:7860");
  const comfyUi = /comfy/i.test(request.query.providerType ?? "");
  try {
    const response = await fetchWithTimeout(comfyUi ? `${endpoint}/object_info/CheckpointLoaderSimple` : `${endpoint}/sdapi/v1/sd-models`, 5000);
    if (response.status === 404) return reply.code(404).send({ error: `${comfyUi ? "ComfyUI checkpoint" : "Stable Diffusion WebUI API"} endpoint is not available.` });
    const text = await response.text();
    if (!response.ok) return reply.code(response.status).send({ error: `Local model list failed (${response.status}).` });
    const models = JSON.parse(text) as unknown;
    return { endpoint, models: comfyUi ? normalizeComfyUiModels(models) : normalizeStableDiffusionModels(models) };
  } catch (error) {
    return reply.code(400).send({ error: `Local model server is not reachable at ${endpoint}` });
  }
});

}
