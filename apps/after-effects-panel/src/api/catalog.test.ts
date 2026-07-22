import { describe, expect, it } from "vitest";
import { filterModelsForOperation, operationsForModels } from "./catalog";
import type { GenerationModel } from "../types";

const image: GenerationModel = { id: "image", provider: "polza", providerModelId: "image", displayName: "Image", inputTypes: ["text", "image"], outputTypes: ["image"], capabilities: ["image.generate"], roles: ["generator", "editor"], availability: { status: "available", configured: true }, parameters: [{ id: "prompt", type: "text" }], nodeType: "polza.image.generate", storedModelId: "image", inputContract: { inputs: [{ kind: "image", minItems: 0, maxItems: 4 }], outputs: [{ kind: "image", minItems: 1 }] } };
const video: GenerationModel = { ...image, id: "video", providerModelId: "video", displayName: "Video", outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"], nodeType: "polza.video.generate", storedModelId: "video" };

describe("generation operation compatibility", () => {
  it("filters image models by image output and keeps text-to-image free of required image input", () => { expect(filterModelsForOperation([image, video], "text-to-image").map((model) => model.id)).toEqual(["image"]); });
  it("requires an image-capable input contract for image-to-image", () => { expect(filterModelsForOperation([image, { ...image, id: "text-only", inputTypes: ["text"], inputContract: undefined }], "image-to-image").map((model) => model.id)).toEqual(["image"]); });
  it("does not mix an upscaler into text-to-image", () => { const upscaler = { ...image, id: "up", capabilities: ["image.upscale"], roles: ["upscaler"], inputContract: { inputs: [{ kind: "image", minItems: 1 }] } }; expect(filterModelsForOperation([image, upscaler], "text-to-image").map((model) => model.id)).toEqual(["image"]); expect(filterModelsForOperation([image, upscaler], "image-upscale").map((model) => model.id)).toEqual(["up"]); });
  it("exposes image and video operations together from executable models", () => { expect(operationsForModels([image, video])).toEqual(expect.arrayContaining(["text-to-image", "image-to-image", "text-to-video", "image-to-video"])); });
  it("drops unavailable models and rebuilds the model list after operation changes", () => { const unavailable = { ...image, id: "off", availability: { status: "unavailable" } }; expect(filterModelsForOperation([image, video, unavailable], "image-to-video").map((model) => model.id)).toEqual(["video"]); });
});
