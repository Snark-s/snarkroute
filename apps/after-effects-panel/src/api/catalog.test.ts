import { describe, expect, it } from "vitest";
import { filterModelsForOperation, modelRequiresPrompt, modelSupportsPrompt, operationsForModels } from "./catalog";
import type { GenerationModel } from "../types";

const image: GenerationModel = { id: "image", provider: "polza", providerModelId: "image", displayName: "Image", inputTypes: ["text", "image"], outputTypes: ["image"], capabilities: ["image.generate"], roles: ["generator", "editor"], availability: { status: "available", configured: true }, parameters: [{ id: "prompt", type: "text" }], nodeType: "polza.image.generate", storedModelId: "image", inputContract: { inputs: [{ kind: "image", minItems: 0, maxItems: 4 }], outputs: [{ kind: "image", minItems: 1 }] } };
const video: GenerationModel = { ...image, id: "video", providerModelId: "video", displayName: "Video", outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"], nodeType: "polza.video.generate", storedModelId: "video" };

describe("generation operation compatibility", () => {
  it("filters image models by image output and keeps text-to-image free of required image input", () => { expect(filterModelsForOperation([image, video], "text-to-image").map((model) => model.id)).toEqual(["image"]); });
  it("requires an image-capable input contract for image-to-image", () => { expect(filterModelsForOperation([image, { ...image, id: "text-only", inputTypes: ["text"], inputContract: undefined }], "image-to-image").map((model) => model.id)).toEqual(["image"]); });
  it("does not treat runnable-without-inputs as image-to-video support", () => {
    const textOnlyVideo: GenerationModel = { ...video, id: "text-video", inputTypes: ["text"], inputContract: { inputs: [], outputs: [{ kind: "video", minItems: 1 }] }, runnableWithSuppliedInputs: true };
    expect(filterModelsForOperation([textOnlyVideo], "image-to-video")).toEqual([]);
  });
  it("does not mix an upscaler into text-to-image", () => { const upscaler: GenerationModel = { ...image, id: "up", capabilities: ["image.upscale"], roles: ["upscaler"], inputContract: { inputs: [{ kind: "image", minItems: 1 }] } }; expect(filterModelsForOperation([image, upscaler], "text-to-image").map((model) => model.id)).toEqual(["image"]); expect(filterModelsForOperation([image, upscaler], "image-upscale").map((model) => model.id)).toEqual(["up"]); });
  it("exposes image and video operations together from executable models", () => { expect(operationsForModels([image, video])).toEqual(expect.arrayContaining(["text-to-image", "image-to-image", "text-to-video", "image-to-video"])); });
  it("drops unavailable models and rebuilds the model list after operation changes", () => { const unavailable: GenerationModel = { ...image, id: "off", availability: { status: "unavailable" } }; expect(filterModelsForOperation([image, video, unavailable], "image-to-video").map((model) => model.id)).toEqual(["video"]); });
  it("shows and requires Prompt for a Polza video model whose media contract omits text", () => {
    const mediaOnlyVideo: GenerationModel = { ...video, inputTypes: ["image"], parameters: [] };
    expect(modelSupportsPrompt(mediaOnlyVideo)).toBe(true);
    expect(modelRequiresPrompt(mediaOnlyVideo)).toBe(true);
  });
  it("keeps multiple production video families when their general contracts are representable", () => {
    const families = ["HappyHorse 1.1", "Kling 3", "Seedance 2", "Wan 2.6"].map((displayName, index): GenerationModel => ({ ...video, id: `video-${index}`, providerModelId: displayName.toLowerCase(), displayName, inputContract: { inputs: [{ kind: "image", minItems: 0, maxItems: index + 1, roles: ["reference"] }], outputs: [{ kind: "video", minItems: 1, maxItems: 1 }] } }));
    expect(filterModelsForOperation(families, "image-to-video").map((model) => model.displayName)).toEqual(["HappyHorse 1.1", "Kling 3", "Seedance 2", "Wan 2.6"]);
  });
});
