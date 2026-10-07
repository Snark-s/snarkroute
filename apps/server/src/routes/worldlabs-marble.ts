import type { FastifyInstance } from "fastify";
import { generateMarbleWorld, getMarbleOperation, getMarbleWorld, WORLD_LABS_MARBLE_MODELS } from "../services/worldlabs-marble";

export async function registerWorldLabsMarbleRoutes(app: FastifyInstance) {
  app.get("/api/worldlabs/marble/models", async () => {
    const configured = Boolean(process.env.WORLDS_API_KEY?.trim());
    const names: Record<string,string> = {
      "marble-1.0-draft":"Marble 1.0 Draft",
      "marble-1.0":"Marble 1.0",
      "marble-1.1":"Marble 1.1",
      "marble-1.1-plus":"Marble 1.1 Plus"
    };
    return {
      models: WORLD_LABS_MARBLE_MODELS.map((id) => ({
        id: "worldlabs:"+id,
        canonicalModelId: id,
        nodeType: "ai.world.generate",
        provider: "worldlabs",
        executionProvider: "worldlabs",
        providerModelId: id,
        displayName: names[id] ?? id,
        recommended: id === "marble-1.1",
        inputTypes: ["text","image"],
        outputTypes: ["scene"],
        capabilities: ["world.generate"],
        maximumImageInputs: 1,
        availability: {
          status: configured ? "available" : "unavailable",
          configured,
          source: "snarkroute"
        },
        parameters: [
          {
            id: "mode", label: "Input", type: "select", default: "image",
            options: [
              { value: "image", label: "Image" },
              { value: "text", label: "Text" }
            ]
          },
          {
            id: "lod", label: "Quality", type: "select", default: "500k",
            options: [
              { value: "100k", label: "Fast (100k)" },
              { value: "500k", label: "Balanced (500k)" },
              { value: "full_res", label: "Max (full res)" }
            ]
          }
        ]
      }))
    };
  });

  app.post<{
    Body: {
      imageUrl?: string;
      imagePath?: string;
      textPrompt?: string;
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
