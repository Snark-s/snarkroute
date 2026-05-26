import { describe, expect, it } from "vitest";
import { livingCanvasModelMetadata } from "./living-canvas-model-catalog";

describe("living canvas model metadata", () => {
  it("exposes Wan video controls without image-generation fields", () => {
    const metadata = livingCanvasModelMetadata("wan/2.6", "polza", "video");

    expect(metadata.generationParameters.map((parameter) => parameter.id)).toEqual(["resolution", "duration", "multi_shots"]);
    expect(metadata.maxImageInputs).toBe(1);
  });

  it("exposes shared controls for regular Polza video generators", () => {
    const metadata = livingCanvasModelMetadata("bytedance/seedance-2-fast", "polza", "video");

    expect(metadata.generationParameters.map((parameter) => parameter.id)).toEqual(["resolution", "duration", "multi_shots"]);
    expect(metadata.maxImageInputs).toBe(1);
  });

  it("does not expose generation controls for video upscalers", () => {
    const metadata = livingCanvasModelMetadata("topaz/video-upscale", "polza", "video");

    expect(metadata.generationParameters).toEqual([]);
  });
});
