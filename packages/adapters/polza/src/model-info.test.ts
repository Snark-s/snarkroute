import { describe, expect, it } from "vitest";
import { polzaModelInfoToModelInfo, type PolzaModelInfo } from "./index";

describe("polzaModelInfoToModelInfo", () => {
  it.each([
    ["chat", "text.generate", ["text"]],
    ["image", "image.generate", ["image"]],
    ["video", "video.generate", ["video"]],
    ["embedding", "embedding.create", ["json"]]
  ] as const)("maps %s models to ModelInfo", (type, capability, outputTypes) => {
    const source: PolzaModelInfo = {
      id: `polza/${type}`,
      name: `${type} model`,
      type,
      supported_parameters: ["prompt"],
      pricing: { unit: "request", price: "0.01" }
    };

    const model = polzaModelInfoToModelInfo(source);

    expect(model).toMatchObject({
      id: `polza/${type}`,
      providerId: "polza",
      title: `${type} model`,
      capabilities: [capability],
      outputTypes
    });
    expect(model.pricingHint).toContain("unit: request");
    expect(model.metadata?.pricing).toEqual({ unit: "request", price: "0.01" });
    expect(model.metadata?.supportedParameters).toEqual(["prompt"]);
  });
});
