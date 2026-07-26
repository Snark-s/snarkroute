import { describe, expect, it } from "vitest";
import { polzaModelInfoToModelInfo, type PolzaModelInfo } from "./index";

describe("polzaModelInfoToModelInfo", () => {
  it.each([
    ["chat", "text.generate", ["text"]],
    ["image", "image.generate", ["image"]],
    ["video", "video.generate", ["video"]],
    ["audio", "audio.generate", ["audio"]],
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

  it("defaults Polza video models to text and image inputs", () => {
    const model = polzaModelInfoToModelInfo({ id: "wan/2.6", type: "video" });

    expect(model.inputTypes).toEqual(["text", "image"]);
    expect(model.supportsImages).toBe(true);
    expect(model.ioContract?.inputs).toEqual([
      { kind: "text", minItems: 0, maxItems: 1 },
      { kind: "image", minItems: 0, maxItems: 1 }
    ]);
  });

  it("uses the shared provider parameter contract for dynamic video inputs", () => {
    const model = polzaModelInfoToModelInfo({
      id: "bytedance/seedance-2",
      type: "video",
      top_provider: { parameters: { images: { min: 0, max: 5, description: "Reference images" }, videos: { min: 0, max: 1 } } }
    });
    expect(model.ioContract?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "image", minItems: 0, maxItems: 5 }),
      expect.objectContaining({ kind: "video", minItems: 0, maxItems: 1 })
    ]));
  });
});
