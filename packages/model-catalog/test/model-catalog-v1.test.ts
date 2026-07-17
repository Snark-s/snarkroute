import { describe, expect, it } from "vitest";
import { modelInputCompatibilityReasonsV1, modelMaxImageInputsV1, modelParameterValidationReasonsV1, modelRunnableWithSuppliedInputsV1, normalizeModelParameterValuesV1, providerParameterDefinitionsV1, providerParameterIOContractV1 } from "../src/index.js";
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

  it.each([
    [{ min: 1, max: 1 }, true],
    [{ min: 1, max: 2 }, true],
    [{ min: 0, max: 4 }, true],
    [{ min: 2, max: 2 }, false]
  ])("evaluates one supplied image against the shared min/max contract: %o", (images, expected) => {
    const ioContract = providerParameterIOContractV1({ images }, [], ["video"]);
    expect(modelRunnableWithSuppliedInputsV1({ ioContract }, { image: 1, video: 0, audio: 0 })).toBe(expected);
  });

  it("rejects text-to-video-only contracts when an image is supplied", () => {
    const ioContract = providerParameterIOContractV1({ prompt: { required: true } }, ["text"], ["video"]);
    expect(modelRunnableWithSuppliedInputsV1({ ioContract }, { image: 1 })).toBe(false);
    expect(modelInputCompatibilityReasonsV1({ ioContract }, { image: 1 })).toContain("unsupported image input");
  });

  it("supports required pricing statuses", () => {
    const statuses: Array<ModelPricingInfoV1["status"]> = ["fresh", "stale", "missing", "unknown"];
    expect(statuses).toEqual(["fresh", "stale", "missing", "unknown"]);
  });

  it("normalizes provider required enums and validates all schema-derived required params", () => {
    const schema = providerParameterDefinitionsV1({
      prompt: { required: true },
      images: { min: 0, max: 1 },
      aspect_ratio: { required: true, values: ["1:1", "16:9", "9:16"] },
      duration: { required: true, default: "5", values: ["5", "10"] }
    });

    expect(schema).toEqual([
      { id: "aspect_ratio", label: "Aspect ratio", type: "select", required: true, options: [{ value: "1:1" }, { value: "16:9" }, { value: "9:16" }] },
      { id: "duration", label: "Duration", type: "select", required: true, default: "5", options: [{ value: "5" }, { value: "10" }] }
    ]);
    expect(modelParameterValidationReasonsV1(schema, { duration: "5" })).toEqual(["Aspect ratio is required"]);
    expect(normalizeModelParameterValuesV1(schema, { aspect_ratio: "16:9", duration: "10", ignored: "x" })).toEqual({ aspect_ratio: "16:9", duration: "10" });
  });
});
