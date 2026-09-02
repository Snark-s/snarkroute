import { describe, expect, it } from "vitest";
import { groupCanonicalModelOptionsV1, mergeProviderModelsWithCuratedMetadata, normalizeProviderModelToV1Input, type ModelOptionForNodeV1 } from "@snarkroute/model-catalog";
import { loadRouteFromText } from "@snarkroute/protocol";
import { imageModelOptionsFromNodeOptions, modelOptionForNodeLabel, providerRouteOptionLabel, providerRouteSelectionKey } from "./modelOptionUtils";

describe("Boojum canonical model selector", () => {
  it("shows a canonical model once and keeps provider choice on the option", () => {
    const providerEntries = [
      normalizeProviderModelToV1Input({ provider: "kie", providerModelId: "kling-3.0/video", displayName: "Kling 3.0 Pro", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"] }),
      normalizeProviderModelToV1Input({ provider: "openrouter", providerModelId: "kwaivgi/kling-3.0-pro", displayName: "Kling 3 Pro", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"] })
    ];
    const options = mergeProviderModelsWithCuratedMetadata(providerEntries, []).map((entry): ModelOptionForNodeV1 => ({ ...entry, nodeType: "ai.video.generate", storedModelId: entry.providerModelId, executionProvider: entry.provider }));
    const [canonical] = groupCanonicalModelOptionsV1(options);
    expect(modelOptionForNodeLabel(canonical)).toBe("Kling 3.0 Pro");
    expect(canonical.providerRoutes?.map((route) => route.provider)).toEqual(["kie", "openrouter"]);
  });

  it("keeps legacy image ids selectable when the current catalog no longer contains them", () => {
    expect(imageModelOptionsFromNodeOptions([], "legacy/provider-image")).toEqual([expect.objectContaining({ id: "legacy/provider-image", disabled: true, note: "not in current catalog" })]);
  });

  it("persists a canonical image id and distinguishes two routes from one provider", () => {
    const options = [
      normalizeProviderModelToV1Input({ provider: "kie", providerModelId: "wan/2-6-text-to-video", displayName: "Wan 2.6 Text to Video", inputTypes: ["text"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"] }),
      normalizeProviderModelToV1Input({ provider: "kie", providerModelId: "wan/2-6-image-to-video", displayName: "Wan 2.6 Image to Video", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"] })
    ];
    const [canonical] = groupCanonicalModelOptionsV1(mergeProviderModelsWithCuratedMetadata(options, []).map((entry): ModelOptionForNodeV1 => ({ ...entry, nodeType: "ai.video.generate", storedModelId: entry.providerModelId, executionProvider: entry.provider })));
    const routes = canonical.providerRoutes!;
    expect(canonical.id).toBe("wan-2.6");
    expect(new Set(routes.map(providerRouteSelectionKey)).size).toBe(2);
    expect(routes.map((route) => providerRouteOptionLabel(route, routes))).toEqual([
      "KIE.ai · wan/2-6-text-to-video",
      "KIE.ai · wan/2-6-image-to-video"
    ]);
  });

  it("reopens canonical provider choices and resolves legacy physical model ids", () => {
    const providerEntries = [
      normalizeProviderModelToV1Input({ provider: "kie", providerModelId: "gpt-5-2", displayName: "GPT-5.2", inputTypes: ["text", "image"], outputTypes: ["text"], capabilities: ["text.generate"], roles: ["generator"] }),
      normalizeProviderModelToV1Input({ provider: "openrouter", providerModelId: "openai/gpt-5.2", displayName: "GPT-5.2", inputTypes: ["text"], outputTypes: ["text"], capabilities: ["text.generate"], roles: ["generator"] })
    ];
    const [canonical] = groupCanonicalModelOptionsV1(mergeProviderModelsWithCuratedMetadata(providerEntries, []).map((entry): ModelOptionForNodeV1 => ({ ...entry, nodeType: "ai.text", storedModelId: entry.providerModelId, executionProvider: entry.provider })));
    const route = loadRouteFromText(JSON.stringify({ routeVersion: "0.1", route: { id: "switch", title: "switch", author: { name: "test" } }, nodes: [{ id: "text", type: "ai.text", params: { model: canonical.id, provider: "openrouter", executionProvider: "openrouter", providerModelId: "openai/gpt-5.2" } }], edges: [] }), "switch.orp.json");
    expect(route.nodes[0].params).toMatchObject({ model: "gpt-5.2", provider: "openrouter", providerModelId: "openai/gpt-5.2" });
    expect(canonical.providerRoutes?.find((candidate) => candidate.provider === route.nodes[0].params?.provider && candidate.providerModelId === route.nodes[0].params?.providerModelId)).toMatchObject({ provider: "openrouter", providerModelId: "openai/gpt-5.2" });
    expect(canonical.providerRoutes?.some((candidate) => candidate.storedModelId === "gpt-5-2")).toBe(true);
    const imageEntries = [
      normalizeProviderModelToV1Input({ provider: "kie", providerModelId: "nano-banana-pro", displayName: "Nano Banana Pro", inputTypes: ["text", "image"], outputTypes: ["image"], capabilities: ["image.generate"], roles: ["generator"] }),
      normalizeProviderModelToV1Input({ provider: "openrouter", providerModelId: "google/gemini-3-pro-image-preview", displayName: "Nano Banana Pro", inputTypes: ["text", "image"], outputTypes: ["image"], capabilities: ["image.generate"], roles: ["generator"] })
    ];
    const [canonicalImage] = groupCanonicalModelOptionsV1(mergeProviderModelsWithCuratedMetadata(imageEntries, []).map((entry): ModelOptionForNodeV1 => ({ ...entry, nodeType: "ai.image.generate", storedModelId: entry.providerModelId, executionProvider: entry.provider })));
    expect(imageModelOptionsFromNodeOptions([canonicalImage], canonicalImage.id)[0].id).toBe("nano-banana-pro");
  });
});
