import { describe, expect, it } from "vitest";
import { groupCanonicalModelOptionsV1, mergeProviderModelsWithCuratedMetadata, normalizeProviderModelToV1Input, type ModelOptionForNodeV1 } from "../src/v1/index.js";

function option(provider: string, providerModelId: string, displayName: string, capabilities = ["video.generate"], pricingMicrousd = 100): ModelOptionForNodeV1 {
  const [entry] = mergeProviderModelsWithCuratedMetadata([normalizeProviderModelToV1Input({ provider, providerModelId, displayName, inputTypes: ["text", "image"], outputTypes: ["video"], capabilities, roles: ["generator"], availability: { status: "available", source: "live" } })], []);
  return { ...entry, nodeType: "ai.video.generate", storedModelId: providerModelId, executionProvider: provider, pricing: { status: "fresh", source: "provider-live", currency: "USD", pricing: { providerCostMicrousd: pricingMicrousd } } };
}

describe("canonical model grouping", () => {
  it("deduplicates confident Kling 3.0 Pro provider names without losing routes", () => {
    const grouped = groupCanonicalModelOptionsV1([
      option("polza", "kling-v3-pro", "Kling v3 Pro", ["video.generate"], 110),
      option("openrouter", "kwaivgi/kling-3.0-pro", "KWAIVGI Kling 3 Pro", ["video.generate"], 120),
      option("kie", "kling-3.0/video", "Kling 3.0 Pro", ["video.generate"], 90)
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ id: "kling-3.0-pro", displayName: "Kling 3.0 Pro" });
    expect(grouped[0].providerRoutes?.map((route) => [route.provider, route.providerModelId])).toEqual([
      ["kie", "kling-3.0/video"], ["polza", "kling-v3-pro"], ["openrouter", "kwaivgi/kling-3.0-pro"]
    ]);
    expect(grouped[0].providerRoutes?.map((route) => route.pricing?.pricing)).toEqual([
      { providerCostMicrousd: 90 }, { providerCostMicrousd: 110 }, { providerCostMicrousd: 120 }
    ]);
    expect(grouped[0].pricing).toBeUndefined();
  });

  it("keeps materially different Kling tiers and motion control separate", () => {
    const grouped = groupCanonicalModelOptionsV1([
      option("kie", "kling-3.0/video", "Kling 3.0 Pro"),
      option("polza", "kling/v3", "Kling 3.0 Standard"),
      option("polza", "kling/v3-motion-control", "Kling 3.0 Motion Control")
    ]);
    expect(grouped.map((entry) => entry.id)).toHaveLength(3);
  });

  it("groups Kling 3.0 Standard across Polza and OpenRouter without merging it into Pro", () => {
    const grouped = groupCanonicalModelOptionsV1([
      option("polza", "kling/v3", "Kling 3.0"),
      option("openrouter", "kwaivgi/kling-v3.0-std", "Kling: Video v3.0 Standard"),
      option("kie", "kling-3.0/video", "Kling 3.0 Pro")
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped.find((entry) => entry.id === "kling-3.0-standard")).toMatchObject({ displayName: "Kling 3.0 Standard" });
    expect(grouped.find((entry) => entry.id === "kling-3.0-standard")?.providerRoutes?.map((route) => route.provider)).toEqual(["polza", "openrouter"]);
    expect(grouped.find((entry) => entry.id === "kling-3.0-pro")?.providerRoutes).toHaveLength(1);
  });

  it("keeps provider capabilities and constraints on provider routes", () => {
    const kie = option("kie", "kling-3.0/video", "Kling 3.0 Pro", ["video.generate"]);
    kie.metadata = { providerConstraints: { audio: true, resolutions: ["1080p"] } };
    const openrouter = option("openrouter", "kwaivgi/kling-3.0-pro", "Kling 3.0 Pro", ["video.generate"]);
    openrouter.metadata = { providerConstraints: { audio: false, resolutions: ["720p"] } };
    const [group] = groupCanonicalModelOptionsV1([kie, openrouter]);
    expect(group.providerRoutes?.find((route) => route.provider === "kie")?.constraints).toEqual({ audio: true, resolutions: ["1080p"] });
    expect(group.providerRoutes?.find((route) => route.provider === "openrouter")?.constraints).toEqual({ audio: false, resolutions: ["720p"] });
  });

  it("retains legacy provider ids as compatibility routes", () => {
    const [group] = groupCanonicalModelOptionsV1([option("openrouter", "kwaivgi/kling-3.0-pro", "Kling 3.0 Pro")]);
    expect(group.id).toBe("kling-3.0-pro");
    expect(group.providerRoutes?.some((route) => route.storedModelId === "kwaivgi/kling-3.0-pro")).toBe(true);
  });

  it("keeps unknown singleton ids unchanged", () => {
    const [group] = groupCanonicalModelOptionsV1([option("openrouter", "vendor/new-model", "New Model")]);
    expect(group.id).toBe("vendor/new-model");
    expect(group.storedModelId).toBe("vendor/new-model");
  });

  it("groups KIE and OpenRouter Nano Banana Pro but not other Nano Banana tiers", () => {
    const grouped = groupCanonicalModelOptionsV1([
      option("kie", "nano-banana-pro", "Nano Banana Pro", ["image.generate"]),
      option("openrouter", "google/gemini-3-pro-image-preview", "Nano Banana Pro", ["image.generate"]),
      option("openrouter", "google/gemini-3-pro-image", "Nano Banana Pro", ["image.generate"]),
      option("openrouter", "google/gemini-3.1-flash-image-preview", "Nano Banana 2", ["image.generate"])
    ]);
    expect(grouped.map((entry) => entry.canonicalModelId).sort()).toEqual(["nano-banana-2", "nano-banana-pro"]);
    expect(grouped.find((entry) => entry.canonicalModelId === "nano-banana-pro")?.providerRoutes).toHaveLength(3);
  });

  it("groups exact Seedance 2.0 routes while keeping Fast separate", () => {
    const grouped = groupCanonicalModelOptionsV1([
      option("kie", "bytedance/seedance-2", "Seedance 2.0"),
      option("polza", "bytedance/seedance-2.0", "Bytedance Seedance 2"),
      option("openrouter", "bytedance/seedance-2.0", "Bytedance Seedance 2.0"),
      option("kie", "bytedance/seedance-2-fast", "Seedance 2.0 Fast")
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped.find((entry) => entry.canonicalModelId === "seedance-2.0")?.providerRoutes).toHaveLength(3);
  });

  it("uses a canonical superset while preserving route-specific reality", () => {
    const textOnly = option("kie", "wan/2-6-text-to-video", "Wan 2.6 Text to Video");
    textOnly.inputTypes = ["text"];
    textOnly.capabilities = ["video.generate"];
    textOnly.ioContract = { inputs: [{ kind: "text", minItems: 1, maxItems: 1, required: true }], outputs: [{ kind: "video", minItems: 1, maxItems: 1, required: true }] };
    textOnly.inputContract = textOnly.ioContract;
    const imageRoute = option("kie", "wan/2-6-image-to-video", "Wan 2.6 Image to Video");
    imageRoute.inputTypes = ["text", "image"];
    imageRoute.capabilities = ["video.generate", "image.reference"];
    imageRoute.ioContract = { inputs: [{ kind: "text", minItems: 1, maxItems: 1, required: true }, { kind: "image", minItems: 1, maxItems: 1, required: true, roles: ["firstFrame"] }], outputs: [{ kind: "video", minItems: 1, maxItems: 1, required: true }] };
    imageRoute.inputContract = imageRoute.ioContract;
    const polza = option("polza", "wan/2.6", "Wan 2.6");
    polza.inputTypes = ["text", "image"];
    polza.ioContract = { inputs: [{ kind: "text", minItems: 1, maxItems: 1, required: true }, { kind: "image", minItems: 0, maxItems: 1, required: false }], outputs: [{ kind: "video", minItems: 1, maxItems: 1, required: true }] };
    polza.inputContract = polza.ioContract;
    const [wan] = groupCanonicalModelOptionsV1([textOnly, imageRoute, polza]);
    expect(wan).toMatchObject({ id: "wan-2.6", displayName: "Wan 2.6", inputTypes: ["text", "image"], capabilities: ["video.generate", "image.reference"] });
    expect(wan.ioContract?.inputs?.find((item) => item.kind === "image")).toMatchObject({ minItems: 0, maxItems: 1, required: false, roles: ["firstFrame"] });
    expect(wan).toMatchObject({ requiredImageInputs: 0, maximumImageInputs: 1, optionalImageInputs: 1, runnableWithSuppliedInputs: true });
    expect(wan.providerRoutes?.find((route) => route.providerModelId === "wan/2-6-image-to-video")?.ioContract?.inputs?.find((item) => item.kind === "image")).toMatchObject({ minItems: 1, required: true });
    expect(wan.providerRoutes?.map((route) => [route.provider, route.providerModelId, route.inputTypes])).toEqual([
      ["kie", "wan/2-6-text-to-video", ["text"]],
      ["kie", "wan/2-6-image-to-video", ["text", "image"]],
      ["polza", "wan/2.6", ["text", "image"]]
    ]);
  });
});
