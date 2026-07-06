import { describe, expect, it } from "vitest";
import { normalizeAvailableModelOptions } from "./modelCatalog";

const baseModel = {
  displayName: "GPT-5.4",
  iconPath: "/api/model-icons/gpt.png",
  inputTypes: ["text"],
  outputTypes: ["text"],
  capabilities: ["text.generate"],
  roles: ["generator"],
  parameters: []
};

describe("available model normalization", () => {
  it("keeps the canonical RuTronix prefix used by the executor", () => {
    const models = normalizeAvailableModelOptions({ models: [{
      ...baseModel,
      id: "rutronix:gpt-5.4",
      provider: "rutronix",
      providerModelId: "gpt-5.4"
    }] });

    expect(models[0]).toMatchObject({ id: "rutronix:gpt-5.4", storedModelId: "rutronix:gpt-5.4", providerId: "rutronix" });
  });

  it("keeps provider-native IDs for other providers", () => {
    const models = normalizeAvailableModelOptions({ models: [{
      ...baseModel,
      id: "openrouter:openai/gpt-5.4",
      provider: "openrouter",
      providerModelId: "openai/gpt-5.4"
    }] });

    expect(models[0]).toMatchObject({ id: "openai/gpt-5.4", storedModelId: "openai/gpt-5.4", providerId: "openrouter" });
  });
});
