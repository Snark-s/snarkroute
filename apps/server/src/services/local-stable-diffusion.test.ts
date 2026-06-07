import { describe, expect, it } from "vitest";
import { normalizeComfyUiModels } from "./local-stable-diffusion";

describe("local model discovery", () => {
  it("extracts checkpoint models from a ComfyUI object-info response", () => {
    expect(normalizeComfyUiModels({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl.safetensors", "flux.safetensors"]] } } }
    })).toEqual([
      { title: "sdxl.safetensors", modelName: "sdxl.safetensors" },
      { title: "flux.safetensors", modelName: "flux.safetensors" }
    ]);
  });
});
