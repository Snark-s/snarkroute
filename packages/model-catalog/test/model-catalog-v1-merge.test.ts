import { describe, expect, it } from "vitest";
import {
  createUnknownCatalogEntryFromProviderModel,
  findCuratedMetadataForProviderModel,
  mergeProviderModelWithCuratedMetadata,
  mergeProviderModelsWithCuratedMetadata,
  normalizeProviderModelToV1Input,
  type CuratedModelMetadataV1
} from "../src/v1/index.js";

describe("Model Catalog V1 merge helpers", () => {
  it("keeps unknown live Polza models present after merge", () => {
    const providerModel = normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "qwen/image-2",
      displayName: "Qwen Image 2",
      inputTypes: ["text"],
      outputTypes: ["image"],
      capabilities: ["image.generate"],
      roles: ["generator"]
    });

    const [merged] = mergeProviderModelsWithCuratedMetadata([providerModel], []);

    expect(merged).toMatchObject({
      id: "polza:qwen/image-2",
      providerModelId: "qwen/image-2",
      catalogStatus: "unknown",
      availability: { status: "available", source: "live" }
    });
  });

  it("allows curated metadata to enrich display and icon without changing providerModelId", () => {
    const providerModel = normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "qwen/image-2",
      displayName: "Raw Qwen Name",
      outputTypes: ["image"],
      capabilities: ["image.generate"]
    });

    const merged = mergeProviderModelWithCuratedMetadata(providerModel, {
      provider: "polza",
      providerModelId: "qwen/image-2",
      displayName: "Qwen Image 2",
      iconKey: "qwen",
      iconPath: "/api/model-icons/qwen.png"
    });

    expect(merged.displayName).toBe("Qwen Image 2");
    expect(merged.iconKey).toBe("qwen");
    expect(merged.iconPath).toBe("/api/model-icons/qwen.png");
    expect(merged.providerModelId).toBe("qwen/image-2");
  });

  it("uses existing model icon filenames for unknown live vendor models", () => {
    const models = [
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "qwen/image", originVendor: "qwen", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "google/gemini-3.1-flash-image-preview", originVendor: "google", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "google/gemini-3-pro-image-preview", originVendor: "google", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "google/gemini-3-pro", originVendor: "google", outputTypes: ["text"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "bytedance/seedream-5-lite", originVendor: "bytedance", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "kling/v3-motion-control", outputTypes: ["video"] }),
      normalizeProviderModelToV1Input({ provider: "gemini", providerModelId: "image.nano-banana", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "tongyi-mai/z-image", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "x-ai/grok-image", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "stability/stable-image-core", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "wan/2.6", outputTypes: ["video"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "minimax/hailuo-2.3", outputTypes: ["video"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "unknown/live-model", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "anthropic/claude-opus-4.7-fast", originVendor: "anthropic", outputTypes: ["text"] })
    ];

    const merged = mergeProviderModelsWithCuratedMetadata(models, []);

    expect(merged.map((model) => [model.providerModelId, model.iconKey, model.iconPath])).toEqual([
      ["qwen/image", "qwen", "/api/model-icons/qwen.png"],
      ["google/gemini-3.1-flash-image-preview", "nano-banana", "/api/model-icons/nano-banana.svg"],
      ["google/gemini-3-pro-image-preview", "nano-banana", "/api/model-icons/nano-banana.svg"],
      ["google/gemini-3-pro", "gemini", "/api/model-icons/gemini.png"],
      ["bytedance/seedream-5-lite", "bytedance", "/api/model-icons/seedream-4-5.png"],
      ["kling/v3-motion-control", "kling", "/api/model-icons/kling.png"],
      ["image.nano-banana", "nano-banana", "/api/model-icons/nano-banana.svg"],
      ["tongyi-mai/z-image", "z-image", "/api/model-icons/z-image.png"],
      ["x-ai/grok-image", "x-ai", "/api/model-icons/grok-image.png"],
      ["stability/stable-image-core", "stability", "/api/model-icons/stability.svg"],
      ["wan/2.6", "wan", "/api/model-icons/wan.svg"],
      ["minimax/hailuo-2.3", "minimax", "/api/model-icons/hailuo.png"],
      ["unknown/live-model", "unknown", "/api/model-icons/unknown.svg"],
      ["anthropic/claude-opus-4.7-fast", "anthropic", "/api/model-icons/claude.png"]
    ]);
  });

  it("does not treat curated metadata as a whitelist", () => {
    const providerModels = [
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "openai/known", outputTypes: ["image"] }),
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "qwen/unknown", outputTypes: ["image"] })
    ];
    const curated: CuratedModelMetadataV1[] = [{ provider: "polza", providerModelId: "openai/known", displayName: "Known" }];

    const merged = mergeProviderModelsWithCuratedMetadata(providerModels, curated);

    expect(merged.map((model) => model.providerModelId)).toEqual(["openai/known", "qwen/unknown"]);
    expect(merged.find((model) => model.providerModelId === "qwen/unknown")?.catalogStatus).toBe("unknown");
  });

  it("matches aliases only when they are explicit curated aliases", () => {
    const providerModel = normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "legacy/image-model" });
    const curated: CuratedModelMetadataV1[] = [
      { provider: "polza", providerModelId: "canonical/image-model", aliases: ["legacy/image-model"], displayName: "Explicit Alias" }
    ];

    expect(findCuratedMetadataForProviderModel(providerModel, curated)?.displayName).toBe("Explicit Alias");
    expect(findCuratedMetadataForProviderModel(
      normalizeProviderModelToV1Input({ provider: "polza", providerModelId: "implicit/image-model" }),
      curated
    )).toBeUndefined();
  });

  it("preserves live IO and capabilities when curated metadata does not override them", () => {
    const providerModel = normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "vendor/model",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate"],
      roles: ["generator"]
    });

    const merged = mergeProviderModelWithCuratedMetadata(providerModel, {
      provider: "openrouter",
      providerModelId: "vendor/model",
      displayName: "Curated Name"
    });

    expect(merged.inputTypes).toEqual(["text", "image"]);
    expect(merged.outputTypes).toEqual(["image"]);
    expect(merged.capabilities).toEqual(["image.generate"]);
  });

  it("exposes curated executable metadata at the top level while keeping audit detail", () => {
    const providerModel = normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "vendor/video",
      outputTypes: ["video"]
    });

    const merged = mergeProviderModelWithCuratedMetadata(providerModel, {
      provider: "openrouter",
      providerModelId: "vendor/video",
      metadata: { maxImageInputs: 1, imageReferenceSyntax: "@image {index}" }
    });

    expect(merged.metadata?.maxImageInputs).toBe(1);
    expect(merged.metadata?.imageReferenceSyntax).toBe("@image {index}");
    expect(merged.metadata?.curated).toEqual({ maxImageInputs: 1, imageReferenceSyntax: "@image {index}" });
  });

  it("can mark topaz/image-upscale as an upscaler through curated metadata", () => {
    const providerModel = normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "topaz/image-upscale",
      outputTypes: ["image"],
      capabilities: ["image.generate"],
      roles: ["generator"]
    });

    const merged = mergeProviderModelWithCuratedMetadata(providerModel, {
      provider: "polza",
      providerModelId: "topaz/image-upscale",
      capabilities: ["image.upscale"],
      roles: ["upscaler"],
      iconKey: "topaz"
    });

    expect(merged.roles).toEqual(["upscaler"]);
    expect(merged.capabilities).toEqual(["image.upscale"]);
    expect(merged.iconKey).toBe("topaz");
  });

  it("creates unknown catalog entries from provider models", () => {
    const providerModel = normalizeProviderModelToV1Input({ provider: "openrouter", providerModelId: "vendor/new-model" });
    const entry = createUnknownCatalogEntryFromProviderModel(providerModel);

    expect(entry.catalogStatus).toBe("unknown");
    expect(entry.id).toBe("openrouter:vendor/new-model");
  });
});
