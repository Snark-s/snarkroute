import { describe, expect, it } from "vitest";
import { defineModelCatalog, listKnownModels } from "../src/index.js";

const allowedOutputTypes = new Set(["text", "image", "video", "audio", "embedding", "json"]);

describe("@snarkroute/model-catalog", () => {
  it("defines required identity fields for every known model", () => {
    for (const model of listKnownModels()) {
      expect(model.provider).toBeTruthy();
      expect(model.providerModelId).toBeTruthy();
      expect(model.outputType).toBeTruthy();
      expect(model.displayName).toBeTruthy();
      expect(model.iconKey).toBeTruthy();
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
});
