import { describe, expect, it } from "vitest";
import { defineModelCatalog, listKnownModels, normalizeProviderModel } from "../src/index.js";

const allowedOutputTypes = new Set(["text", "image", "video", "audio", "embedding", "json", "unknown"]);

describe("@snarkroute/model-catalog", () => {
  it("defines required identity fields for every known model", () => {
    for (const model of listKnownModels()) {
      expect(model.provider).toBeTruthy();
      expect(model.providerModelId).toBeTruthy();
      expect(model.outputType).toBeTruthy();
      expect(model.displayName).toBeTruthy();
      expect(model.iconKey).toBeTruthy();
      expect(model.catalogStatus).toBe("known");
    }
  });

  it("defines valid model parameters", () => {
    for (const model of listKnownModels()) {
      for (const parameter of model.parameters) {
        expect(parameter.id).toBeTruthy();
        expect(parameter.type).toBeTruthy();
        if (parameter.type === "select") {
          expect(parameter.options?.length).toBeGreaterThan(0);
          if (parameter.default !== undefined) {
            expect(parameter.options?.some((option) => option.value === parameter.default)).toBe(true);
          }
        } else {
          expect(parameter.options ?? []).toHaveLength(0);
        }
      }
    }
  });

  it("rejects duplicate provider and providerModelId entries", () => {
    expect(() => defineModelCatalog([
      { provider: "gemini", providerModelId: "same-model", displayName: "First", outputType: "text", iconKey: "gemini" },
      { provider: "gemini", providerModelId: "same-model", displayName: "Second", outputType: "text", iconKey: "gemini" }
    ])).toThrow("Duplicate model catalog entry");
  });

  it("uses only allowed output types", () => {
    for (const model of listKnownModels()) {
      expect(allowedOutputTypes.has(model.outputType)).toBe(true);
    }
  });

  it("uses non-empty icon keys", () => {
    for (const model of listKnownModels()) {
      expect(model.iconKey.trim()).not.toBe("");
      expect(model.iconPath).toContain("/api/model-icons/");
    }
  });

  it("returns unknown output for unknown provider models", () => {
    const model = normalizeProviderModel("openrouter", { id: "some/provider-model", outputTypes: ["image"] });
    expect(model.outputType).toBe("unknown");
    expect(model.inputTypes).toEqual([]);
    expect(model.parameters).toEqual([]);
    expect(model.catalogStatus).toBe("unknown");
  });

  it("does not default unknown provider models to text", () => {
    const model = normalizeProviderModel("polza", { id: "new-chat-model", type: "chat" });
    expect(model.outputType).not.toBe("text");
    expect(model.outputType).toBe("unknown");
  });

  it("does not infer image from unknown model names or metadata", () => {
    const model = normalizeProviderModel("openrouter", {
      id: "vendor/amazing-image-model",
      name: "Amazing Image Generator",
      description: "image model",
      architecture: { output_modalities: ["image"], modality: "text->image" }
    });
    expect(model.outputType).toBe("unknown");
    expect(model.iconKey).toBe("openrouter");
  });

  it("returns curated metadata for known models", () => {
    const model = normalizeProviderModel("gemini", { id: "image.nano-banana", name: "image name should not matter" });
    expect(model.outputType).toBe("image");
    expect(model.iconKey).toBe("nano-banana");
    expect(model.catalogStatus).toBe("known");
  });
});
