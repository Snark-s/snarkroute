import type { FastifyInstance } from "fastify";
import { getPromptLibraryPrompt, loadPromptLibrary, summarizePromptLibrary, type PromptLibrary } from "@snarkroute/nodes";
import { errorMessage } from "../services/errors";
import { createPromptAssetFromGeneratedImage, deletePromptAsset, type CreatePromptAssetBody, type UpdatePromptAssetBody, updatePromptAsset } from "../prompt-library/service";

let promptLibraryCache: PromptLibrary = { categories: [], diagnostics: [] };

export async function refreshPromptLibraryCache(): Promise<void> {
  promptLibraryCache = await loadPromptLibrary();
}

export async function registerPromptLibraryRoutes(app: FastifyInstance) {
app.get("/api/prompt-library", async (request, reply) => {
  try {
    promptLibraryCache = await loadPromptLibrary();
    return summarizePromptLibrary(promptLibraryCache);
  } catch (error) {
    return reply.code(404).send({ error: errorMessage(error), categories: [] });
  }
});

app.get<{ Params: { category: string; id: string } }>("/api/prompt-library/:category/:id", async (request, reply) => {
  try {
    promptLibraryCache = await loadPromptLibrary();
    const prompt = getPromptLibraryPrompt(promptLibraryCache, request.params.category, request.params.id);
    if (!prompt) return reply.code(404).send({ error: `Prompt "${request.params.category}/${request.params.id}" was not found.` });
    return prompt;
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.post("/api/prompt-library/refresh", async (request, reply) => {
  try {
    promptLibraryCache = await loadPromptLibrary();
    return summarizePromptLibrary(promptLibraryCache);
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error), categories: [], diagnostics: [{ path: "data/prompt-library", severity: "error", message: errorMessage(error) }] });
  }
});

app.patch<{ Params: { category: string; id: string }; Body: UpdatePromptAssetBody }>("/api/prompt-library/:category/:id", async (request, reply) => {
  try {
    const updated = await updatePromptAsset(request.params.category, request.params.id, request.body ?? {});
    promptLibraryCache = await loadPromptLibrary();
    return { ok: true, ...updated, library: summarizePromptLibrary(promptLibraryCache) };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.delete<{ Params: { category: string; id: string } }>("/api/prompt-library/:category/:id", async (request, reply) => {
  try {
    const deleted = await deletePromptAsset(request.params.category, request.params.id);
    promptLibraryCache = await loadPromptLibrary();
    return { ok: true, ...deleted, library: summarizePromptLibrary(promptLibraryCache) };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: CreatePromptAssetBody }>("/api/prompt-library/generated-image", async (request, reply) => {
  try {
    const saved = await createPromptAssetFromGeneratedImage(request.body ?? {});
    promptLibraryCache = await loadPromptLibrary();
    return { ok: true, ...saved, library: summarizePromptLibrary(promptLibraryCache) };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

}
