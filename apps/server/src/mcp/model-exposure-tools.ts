import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelCatalogEntryV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { z } from "zod";
import { errorMessage } from "../services/errors";
import { groupModelExposure, modelExposureEntries, readModelExposurePolicy, type ModelExposurePolicy } from "../services/model-exposure";

export const MODEL_EXPOSURE_INSTRUCTIONS = " Models: models_list shows the SnarkRoute models and providers the owner shares with other networks, grouped by type (text, image, video, audio, 3D, upscale). Use only listed models; Model Gateway rejects MCP jobs for models the owner has not shared (local-only and selected-only settings in the Workshop).";

type Deps = { catalog: () => Promise<ModelCatalogEntryV1[]>; policy: () => Promise<ModelExposurePolicy> };
const types = ["text", "image", "video", "audio", "model", "upscale", "embedding", "other"] as const;

export function registerModelExposureTools(server: McpServer, deps?: Deps): void {
  server.registerTool("models_list", {
    description: "List the SnarkRoute models and providers the owner shares with other networks, grouped by type. Only these may be used through SnarkRoute; hidden models are omitted. Filter by type or provider; availableOnly (default true) drops models whose provider is offline or unconfigured.",
    inputSchema: {
      type: z.enum(types).optional(),
      provider: z.string().max(100).optional(),
      availableOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(2000).optional()
    },
    annotations: { readOnlyHint: true }
  }, async input => {
    try {
      const loadCatalog = deps?.catalog ?? (async () => (await import("../routes/models")).loadLiveModelCatalogV1());
      const [policy, catalog] = await Promise.all([(deps?.policy ?? (() => readModelExposurePolicy()))(), loadCatalog()]);
      const availableOnly = input.availableOnly !== false;
      const shared = modelExposureEntries(catalog, policy).filter(entry => entry.exposed && (!availableOnly || entry.available)
        && (!input.type || entry.type === input.type) && (!input.provider || entry.provider === input.provider));
      const limit = input.limit ?? 300;
      const groups = groupModelExposure(shared.slice(0, limit), policy).map(group => ({
        type: group.type, label: group.label, modelCount: group.modelCount,
        providers: group.providers.map(provider => ({ provider: provider.provider, local: provider.local,
          models: provider.models.map(model => ({ id: model.id, providerModelId: model.providerModelId, name: model.displayName, available: model.available })) }))
      }));
      const result = { policy: { localOnly: policy.localOnly, selectedOnly: policy.selectedOnly }, modelCount: shared.length, truncated: shared.length > limit, groups };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] }; }
  });
}
