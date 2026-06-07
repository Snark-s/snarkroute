import { describe, expect, it } from "vitest";
import { livingCanvasModelMetadata } from "./living-canvas-model-catalog";

describe("living canvas model metadata", () => {
  it("exposes Wan video controls with its reference image limit", () => {
    const metadata = livingCanvasModelMetadata("wan/2.6", "polza", "video");

    expect(metadata.generationParameters.map((parameter) => parameter.id)).toEqual(["resolution", "duration", "multi_shots"]);
    expect(metadata.maxImageInputs).toBe(2);
  });

  it("exposes shared controls and reference image limits for regular Polza video generators", () => {
    const metadata = livingCanvasModelMetadata("bytedance/seedance-2-fast", "polza", "video");

    expect(metadata.generationParameters.map((parameter) => parameter.id)).toEqual(["resolution", "duration", "multi_shots"]);
    expect(metadata.maxImageInputs).toBe(9);
  });

  it("does not expose generation controls for video upscalers", () => {
    const metadata = livingCanvasModelMetadata("topaz/video-upscale", "polza", "video");

    expect(metadata.generationParameters).toEqual([]);
    expect(metadata.maxImageInputs).toBe(1);
  });
});
