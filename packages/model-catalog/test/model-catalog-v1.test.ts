import { describe, expect, it } from "vitest";
import { modelMaxImageInputsV1 } from "../src/index.js";
import type { ModelCatalogEntryV1, ModelOptionForNodeV1, ModelPricingInfoV1, ModelRoleV1 } from "../src/index.js";

const baseEntry: ModelCatalogEntryV1 = {
  id: "polza:openai/gpt-5.4-image-2",
  provider: "polza",
  providerModelId: "openai/gpt-5.4-image-2",
  originVendor: "openai",
  displayName: "GPT-5.4 Image 2",
  iconKey: "gpt",
  iconPath: "/api/model-icons/gpt.png",
  inputTypes: ["text", "image"],
  outputTypes: ["image"],
  capabilities: ["image.generate"],
  roles: ["generator"],
  availability: { status: "available", source: "live", configured: true },
  parameters: [],
  pricing: { status: "fresh", source: "provider-cache", currency: "RUB" },
  catalogStatus: "known",
  metadata: {}
};

describe("Model Catalog V1 types", () => {
  it("keeps provider-native storedModelId separate from unified id", () => {
    const option: ModelOptionForNodeV1 = {
      ...baseEntry,
      nodeType: "polza.image.generate",
      storedModelId: baseEntry.providerModelId,
      executionProvider: "polza",
      compatibilityReason: "Polza image model"
    };

    expect(option.id).toBe("polza:openai/gpt-5.4-image-2");
    expect(option.storedModelId).toBe("openai/gpt-5.4-image-2");
  });

  it("does not require node compatibility on base catalog entries", () => {
    expect("nodeCompatibility" in baseEntry).toBe(false);
    expect(baseEntry.providerModelId).toBeTruthy();
  });

  it("supports required model roles", () => {
    const roles: ModelRoleV1[] = ["generator", "editor", "upscaler", "router", "embedding"];
    expect(roles).toEqual(expect.arrayContaining(["generator", "editor", "upscaler", "router", "embedding"]));
  });

  it("supports required availability sources", () => {
    const sources: Array<ModelCatalogEntryV1["availability"]["source"]> = ["live", "cache", "curated", "fallback"];
    expect(sources).toEqual(["live", "cache", "curated", "fallback"]);
  });

  it("resolves image input limits from shared catalog metadata", () => {
    expect(modelMaxImageInputsV1({
      provider: "openrouter",
      providerModelId: "kwaivgi/kling-video-o1",
      outputTypes: ["video"],
      metadata: { maxImageInputs: 7 }
    })).toBe(7);

    expect(modelMaxImageInputsV1({
      provider: "polza",
      providerModelId: "wan/2.6",
      outputTypes: ["video"]
    })).toBe(1);
  });

  it("supports required pricing statuses", () => {
    const statuses: Array<ModelPricingInfoV1["status"]> = ["fresh", "stale", "missing", "unknown"];
    expect(statuses).toEqual(["fresh", "stale", "missing", "unknown"]);
  });
});
