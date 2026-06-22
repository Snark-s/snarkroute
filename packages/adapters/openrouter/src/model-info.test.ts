import { describe, expect, it } from "vitest";
import { openRouterModelInfoToModelInfo, type OpenRouterModelInfo } from "./index";

describe("openRouterModelInfoToModelInfo", () => {
  it("maps OpenRouter image catalog metadata to ModelInfo", () => {
    const source: OpenRouterModelInfo = {
      id: "provider/image-model",
      provider: "openrouter",
      kind: "image",
      name: "Image Model",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: ["prompt", "response_format"],
      supported_aspect_ratios: ["1:1", "16:9"],
      supported_resolutions: ["1024x1024"],
      pricing: { image: "0.02" }
    };

    const model = openRouterModelInfoToModelInfo(source);

    expect(model).toMatchObject({
      id: "provider/image-model",
      providerId: "openrouter",
      title: "Image Model",
      capabilities: ["image.generate"],
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      supportsImages: true,
      supportsJson: true
    });
    expect(model.pricingHint).toContain("image: 0.02");
    expect(model.metadata?.pricing).toEqual({ image: "0.02" });
    expect(model.metadata?.supportedParameters).toEqual(["prompt", "response_format"]);
    expect(model.metadata?.supportedAspectRatios).toEqual(["1:1", "16:9"]);
    expect(model.defaultParameters).toEqual({ aspectRatio: "1:1", resolution: "1024x1024" });
  });

  it("keeps text generation as the default capability for text models", () => {
    const model = openRouterModelInfoToModelInfo({
      id: "provider/text-model",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] }
    });

    expect(model.capabilities).toEqual(["text.generate"]);
    expect(model.outputTypes).toEqual(["text"]);
  });

  it("marks image-to-video OpenRouter models as accepting image input", () => {
    const model = openRouterModelInfoToModelInfo({
      id: "kwaivgi/kling-video-o1",
      kind: "video",
      description: "Supports text and image inputs with video output, enabling image-to-video workflows.",
      architecture: { output_modalities: ["video"] }
    });

    expect(model.capabilities).toEqual(["video.generate"]);
    expect(model.inputTypes).toEqual(["text", "image"]);
    expect(model.supportsImages).toBe(true);
  });
});
