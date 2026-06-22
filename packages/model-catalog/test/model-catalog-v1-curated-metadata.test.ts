import { describe, expect, it } from "vitest";
import {
  findCuratedModelMetadataV1,
  getCuratedModelMetadataV1,
  listCuratedAliasesV1,
  listCuratedModelMetadataV1
} from "../src/v1/index.js";

describe("Model Catalog V1 curated metadata registry", () => {
  it("curates topaz/image-upscale as an upscaler", () => {
    const metadata = getCuratedModelMetadataV1("polza", "topaz/image-upscale");
    expect(metadata.roles).toEqual(["upscaler"]);
    expect(metadata.capabilities).toEqual(["image.upscale"]);
    expect(metadata.outputTypes).toEqual(["image"]);
    expect(metadata.iconKey).toBe("topaz");
  });

  it("curates topaz/video-upscale as a video upscaler", () => {
    const metadata = getCuratedModelMetadataV1("polza", "topaz/video-upscale");
    expect(metadata.roles).toEqual(["upscaler"]);
    expect(metadata.capabilities).toEqual(["video.upscale"]);
    expect(metadata.outputTypes).toEqual(["video"]);
    expect(metadata.iconKey).toBe("topaz");
  });

  it("curates qwen/image-2 without implying availability", () => {
    const metadata = getCuratedModelMetadataV1("polza", "qwen/image-2");
    expect(metadata.originVendor).toBe("qwen");
    expect(metadata.roles).toEqual(["generator"]);
    expect("availability" in metadata).toBe(false);
  });

  it("curates Nano Banana 2 icon metadata for both providers", () => {
    for (const provider of ["polza", "openrouter"] as const) {
      const metadata = getCuratedModelMetadataV1(provider, "google/gemini-3.1-flash-image-preview");
      expect(metadata.originVendor).toBe("nano-banana");
      expect(metadata.iconKey).toBe("nano-banana");
      expect(metadata.iconPath).toBe("/api/model-icons/nano-banana.svg");
    }
    const proMetadata = getCuratedModelMetadataV1("openrouter", "google/gemini-3-pro-image-preview");
    expect(proMetadata.originVendor).toBe("nano-banana");
    expect(proMetadata.iconKey).toBe("nano-banana");
    expect(proMetadata.iconPath).toBe("/api/model-icons/nano-banana.svg");
  });

  it("looks up curated metadata by provider and providerModelId", () => {
    expect(findCuratedModelMetadataV1("polza", "openai/gpt-5.4-image-2")?.originVendor).toBe("openai");
    expect(findCuratedModelMetadataV1("openrouter", "openai/gpt-5.4-image-2")).toBeUndefined();
  });

  it("matches aliases only when explicitly declared", () => {
    expect(listCuratedAliasesV1()).toContainEqual({
      provider: "polza",
      providerModelId: "black-forest-labs/flux.2-flex",
      alias: "polza.flux-2-flex"
    });
    expect(findCuratedModelMetadataV1("polza", "polza.flux-2-flex")?.providerModelId).toBe("black-forest-labs/flux.2-flex");
    expect(findCuratedModelMetadataV1("polza", "flux.2-flex")).toBeUndefined();
  });

  it("curates Kling Video O1 as image-to-video", () => {
    const metadata = getCuratedModelMetadataV1("openrouter", "kwaivgi/kling-video-o1");
    expect(metadata.originVendor).toBe("kling");
    expect(metadata.inputTypes).toEqual(["text", "image"]);
    expect(metadata.outputTypes).toEqual(["video"]);
    expect(metadata.metadata?.maxImageInputs).toBe(1);
  });

  it("is not a whitelist", () => {
    const curatedProviderModelIds = new Set(listCuratedModelMetadataV1().map((entry) => entry.providerModelId));
    expect(curatedProviderModelIds.has("unlisted/live-provider-model")).toBe(false);
  });

  it("returns undefined for unknown model lookup", () => {
    expect(findCuratedModelMetadataV1("polza", "unknown/model")).toBeUndefined();
  });

  it("curates openai/gpt-image-1.5 as generator and editor", () => {
    const metadata = getCuratedModelMetadataV1("polza", "openai/gpt-image-1.5");
    expect(metadata.roles).toEqual(["generator", "editor"]);
    expect(metadata.outputTypes).toEqual(["image"]);
  });

  it("has the expected initial curated model count", () => {
    expect(listCuratedModelMetadataV1()).toHaveLength(14);
  });
});
