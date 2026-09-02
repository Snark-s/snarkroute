import { describe, expect, it } from "vitest";
import {
  assembleModelCatalogV1,
  canonicalModelCatalogV1,
  fallbackProviderModelsForCatalogV1,
  compatibilityReasonsForNodeV1,
  modelCompatibilityDebugForNodeV1,
  modelOptionsForNodeV1,
  normalizeOpenRouterModelsForCatalogV1,
  normalizeLocalUpscaleModelsForCatalogV1,
  normalizePolzaModelsForCatalogV1
} from "../src/services/model-catalog-v1";

describe("server Model Catalog V1 assembly", () => {
  it("publishes local upscale capabilities, parameters, required image input and zero API cost", () => {
    const catalog = assembleModelCatalogV1({
      localUpscaleModels: [{
        id: "4x-realesrgan-x4plus",
        name: "RealESRGAN x4Plus",
        inputTypes: ["image"],
        outputTypes: ["image"],
        capabilities: ["image.upscale"],
        availability: { status: "available", source: "live", configured: true },
        top_provider: { parameters: { image: { required: true, min: 1, max: 1 }, scale: { type: "integer", default: 4, enum: [4] }, tile_size: { type: "integer", default: 256, min: 64, max: 2048 }, tile_overlap: { type: "integer", default: 32, min: 0, max: 256 }, device: { enum: ["auto", "cuda", "cpu"], default: "auto" } } }
      }]
    });
    const [model] = modelOptionsForNodeV1("local_upscale", catalog);
    expect(model).toMatchObject({ provider: "local_upscale", storedModelId: "4x-realesrgan-x4plus", roles: ["upscaler"], capabilities: ["image.upscale"], requiredImageInputs: 1, maximumImageInputs: 1, pricing: { pricing: { providerCostMicrousd: 0, apiCost: 0 } } });
    expect(model.parameters.map((parameter) => parameter.id)).toEqual(["scale", "tile_size", "tile_overlap", "device"]);
    expect(normalizeLocalUpscaleModelsForCatalogV1([{ id: "4x-test", type: "image", capabilities: ["image.upscale"] }])[0].provider).toBe("local_upscale");
  });
  it("keeps live unknown Polza models present after merge", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{ id: "qwen/image-2", name: "Qwen Image 2", type: "image" }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "qwen/image-2");
    expect(model).toMatchObject({
      id: "polza:qwen/image-2",
      provider: "polza",
      providerModelId: "qwen/image-2",
      originVendor: "qwen",
      availability: { status: "available", source: "live" }
    });
  });

  it("applies canonical upscaler role to live topaz/image-upscale", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{ id: "topaz/image-upscale", name: "Topaz", type: "image" }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "topaz/image-upscale");
    expect(model?.roles).toEqual(["upscaler"]);
    expect(model?.capabilities).toEqual(["image.upscale"]);
    expect(model?.catalogStatus).toBe("known");
  });

  it("applies canonical upscaler role to live topaz/video-upscale", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{ id: "topaz/video-upscale", name: "Topaz Video Upscale", type: "video" }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "topaz/video-upscale");
    expect(model).toMatchObject({
      provider: "polza",
      providerModelId: "topaz/video-upscale",
      originVendor: "topaz",
      iconKey: "topaz",
      iconPath: "/api/model-icons/topaz.svg",
      outputTypes: ["video"],
      capabilities: ["video.upscale"],
      roles: ["upscaler"],
      catalogStatus: "known"
    });
  });

  it("applies canonical generator/editor roles to live openai/gpt-image-1.5", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{ id: "openai/gpt-image-1.5", name: "raw name", type: "image" }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "openai/gpt-image-1.5");
    expect(model?.roles).toEqual(["generator", "editor"]);
    expect(model?.displayName).toBe("GPT Image 1.5");
    expect(model?.parameters.map((parameter) => parameter.id)).toEqual(["aspectRatio", "quality"]);
  });

  it("adds V1 UI generation parameters for live image and video models without raw provider enrichment", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [
        { id: "vendor/new-image", type: "image" },
        { id: "vendor/new-video", type: "video" }
      ],
      fallbackModels: fallbackProviderModelsForCatalogV1()
    });

    expect(catalog.find((entry) => entry.providerModelId === "vendor/new-image")?.parameters.map((parameter) => parameter.id)).toEqual(["aspectRatio", "imageResolution", "quality", "outputFormat", "n"]);
    const video = catalog.find((entry) => entry.providerModelId === "vendor/new-video");
    expect(video?.parameters.map((parameter) => parameter.id)).toEqual(["resolution", "duration", "multi_shots"]);
    expect(video?.metadata?.maxImageInputs).toBe(14);
    expect(catalog.find((entry) => entry.providerModelId === "image.nano-banana")?.parameters.map((parameter) => parameter.id)).toEqual(["aspectRatio", "imageSize"]);
  });

  it("merges provider snake_case parameters with curated camelCase parameters", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{
        id: "openai/gpt-5.4-image-2",
        type: "image",
        top_provider: {
          parameters: {
            aspect_ratio: { required: true, enum: ["1:1", "16:9"], default: "1:1" },
            images: { min: 0, max: 4 }
          }
        }
      }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "openai/gpt-5.4-image-2");
    expect(model?.parameters.filter((parameter) => parameter.id.replace(/_/g, "").toLowerCase() === "aspectratio")).toHaveLength(1);
    expect(model?.parameters[0]).toMatchObject({ id: "aspect_ratio", default: "1:1", required: true });
    expect(model?.parameters.some((parameter) => parameter.id === "images")).toBe(false);
    expect(model?.ioContract?.inputs.find((input) => input.kind === "image")?.maxItems).toBe(4);
  });

  it("uses only provider-native controls for Kling 3 Motion Control", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{
        id: "kling/v3-motion-control",
        type: "video",
        top_provider: {
          parameters: {
            images: { required: true, min: 1, max: 1 },
            videos: { required: true, min: 1, max: 1 },
            mode: { enum: ["720p", "1080p"], default: "720p" },
            character_orientation: { enum: ["image", "video"], default: "image" }
          }
        }
      }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "kling/v3-motion-control");
    expect(model?.parameters.map((parameter) => parameter.id)).toEqual(["mode", "character_orientation"]);
    expect(model?.ioContract?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "image", minItems: 1, maxItems: 1 }),
      expect.objectContaining({ kind: "video", minItems: 1, maxItems: 1 })
    ]));
  });

  it("uses custom-mode Suno music parameters from the catalog overlay", () => {
    const catalog = assembleModelCatalogV1({ fallbackModels: fallbackProviderModelsForCatalogV1() });
    const suno = catalog.find((entry) => entry.providerModelId === "suno/generate");

    expect(suno?.displayName).toBe("Suno Music Generate");
    expect(suno?.inputTypes).toEqual(["text", "audio"]);
    expect(suno?.parameters.map((parameter) => parameter.id)).toEqual(["mode", "instrumental", "style", "title", "version", "negative_tags", "language", "tempo", "voice_style"]);
    expect(suno?.parameters.find((parameter) => parameter.id === "mode")?.default).toBe("custom");
    expect(suno?.parameters.find((parameter) => parameter.id === "style")?.enabledWhen).toEqual({ parameterId: "mode", equals: ["custom"] });
    expect(suno?.parameters.find((parameter) => parameter.id === "instrumental")?.advanced).toBeUndefined();
    expect(suno?.parameters.find((parameter) => parameter.id === "instrumental")?.enabledWhen).toEqual({ parameterId: "mode", equals: ["simple"] });
    expect(modelOptionsForNodeV1("ai.audio.generate", catalog).map((entry) => entry.providerModelId)).toContain("suno/generate");
    expect(catalog.find((entry) => entry.providerModelId === "suno/sounds")?.inputTypes).toEqual(["text", "audio"]);
    expect(catalog.find((entry) => entry.providerModelId === "suno/sounds")?.parameters.map((parameter) => parameter.id)).toEqual(suno?.parameters.map((parameter) => parameter.id));
  });

  it("limits Polza Wan 2.6 video generation to one image input", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{ id: "wan/2.6", type: "video" }]
    });

    const wan = catalog.find((entry) => entry.providerModelId === "wan/2.6");
    expect(wan?.metadata?.maxImageInputs).toBe(1);
  });

  it("preserves provider-native providerModelId and creates unified ids", () => {
    const [model] = normalizePolzaModelsForCatalogV1([{ id: "openai/gpt-5.4-image-2", type: "image" }]);

    expect(model.providerModelId).toBe("openai/gpt-5.4-image-2");
    expect(model.id).toBe("polza:openai/gpt-5.4-image-2");
  });

  it("does not create unavailable models from canonical metadata alone", () => {
    const catalog = assembleModelCatalogV1({ polzaModels: [] });

    expect(catalog).toHaveLength(0);
  });

  it("does not use canonical metadata as a whitelist", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [
        { id: "openai/gpt-image-1.5", type: "image" },
        { id: "vendor/unlisted-live-model", type: "image" }
      ]
    });

    expect(catalog.map((entry) => entry.providerModelId)).toEqual(["openai/gpt-image-1.5", "vendor/unlisted-live-model"]);
    expect(catalog.find((entry) => entry.providerModelId === "vendor/unlisted-live-model")?.catalogStatus).toBe("unknown");
  });

  it("keeps live OpenRouter unknown models present", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [{
        id: "vendor/new-openrouter-model",
        name: "New OpenRouter Model",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] }
      }]
    });

    expect(catalog[0]).toMatchObject({
      id: "openrouter:vendor/new-openrouter-model",
      provider: "openrouter",
      providerModelId: "vendor/new-openrouter-model",
      catalogStatus: "unknown",
      outputTypes: ["text"],
      capabilities: ["text.generate"]
    });
  });

  it("exposes OpenRouter video generation parameters from supported values", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [{
        id: "kwaivgi/kling-v3.0-std",
        name: "Kling: Video v3.0 Standard",
        kind: "video",
        architecture: { output_modalities: ["video"] },
        supported_durations: ["3", "4", "5"],
        supported_aspect_ratios: ["16:9", "9:16", "1:1"],
        supported_resolutions: ["720p"]
      }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "kwaivgi/kling-v3.0-std");
    expect(model?.parameters).toEqual([
      expect.objectContaining({ id: "aspectRatio", type: "select", default: "16:9" }),
      expect.objectContaining({ id: "duration", type: "select", default: "3" }),
      expect.objectContaining({ id: "resolution", type: "select", default: "720p" })
    ]);
    expect(model?.parameters[0]?.options?.map((option) => option.value)).toEqual(["16:9", "9:16", "1:1"]);
  });

  it("uses curated image-input metadata when OpenRouter omits video model input modalities", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [{
        id: "kwaivgi/kling-video-o1",
        name: "Kling: Video O1",
        kind: "video",
        architecture: { output_modalities: ["video"] },
        supported_durations: ["5", "10"],
        supported_resolutions: ["720p"]
      }]
    });

    const model = catalog.find((entry) => entry.providerModelId === "kwaivgi/kling-video-o1");
    expect(model?.inputTypes).toEqual(["text", "image"]);
    expect(model?.outputTypes).toEqual(["video"]);
    expect(model?.metadata?.maxImageInputs).toBe(7);
  });

  it("normalizes OpenRouter models independently from routes", () => {
    const [model] = normalizeOpenRouterModelsForCatalogV1([{ id: "openai/gpt-5.2", kind: "chat" }]);

    expect(model.provider).toBe("openrouter");
    expect(model.providerModelId).toBe("openai/gpt-5.2");
  });

  it("returns provider-native Polza image node options and excludes upscalers", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [
        { id: "openai/gpt-image-1.5", type: "image" },
        { id: "qwen/unlisted-live-image", type: "image" },
        { id: "topaz/image-upscale", type: "image" }
      ]
    });

    const options = modelOptionsForNodeV1("polza.image.generate", catalog);

    expect(options.map((entry) => entry.providerModelId)).toEqual(["openai/gpt-image-1.5", "qwen/unlisted-live-image"]);
    expect(options.map((entry) => entry.storedModelId)).toEqual(["openai/gpt-image-1.5", "qwen/unlisted-live-image"]);
    expect(options.every((entry) => !entry.storedModelId.startsWith("polza:"))).toBe(true);
  });

  it("does not treat Polza text models with image input as image-output models", () => {
    const textModelIds = [
      "openai/gpt-5.1",
      "openai/gpt-5.1-codex-mini",
      "openai/gpt-5.2",
      "openai/gpt-5.2-chat"
    ];
    const catalog = assembleModelCatalogV1({
      polzaModels: [
        ...textModelIds.map((id) => ({
          id,
          type: "chat",
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }
        })),
        { id: "qwen/image-2", type: "image", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
        { id: "topaz/image-upscale", type: "image", architecture: { input_modalities: ["image"], output_modalities: ["image"] } }
      ]
    });

    for (const id of textModelIds) {
      expect(catalog.find((entry) => entry.providerModelId === id)?.outputTypes).toEqual(["text"]);
    }

    const options = modelOptionsForNodeV1("polza.image.generate", catalog);
    const optionIds = options.map((entry) => entry.storedModelId);

    expect(optionIds).toContain("qwen/image-2");
    expect(optionIds).not.toContain("topaz/image-upscale");
    for (const id of textModelIds) expect(optionIds).not.toContain(id);
    expect(optionIds.every((id) => !id.startsWith("polza:"))).toBe(true);
    expect(options.every((entry) => entry.providerModelId === entry.storedModelId)).toBe(true);
  });

  it("normalizes known text-only GPT models to text output even when provider metadata also lists image", () => {
    const textModelIds = [
      "openai/gpt-5.1",
      "openai/gpt-5.1-codex-mini",
      "openai/gpt-5.2",
      "openai/gpt-5.2-chat"
    ];
    const catalog = assembleModelCatalogV1({
      polzaModels: textModelIds.map((id) => ({
        id,
        type: "chat",
        outputTypes: ["text", "image"],
        capabilities: ["text.generate", "image.generate"]
      }))
    });

    for (const id of textModelIds) {
      expect(catalog.find((entry) => entry.providerModelId === id)?.outputTypes).toEqual(["text"]);
    }
  });

  it("keeps OpenRouter image options for ai.image.generate", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [
        { id: "openai/gpt-image-1", architecture: { output_modalities: ["image"] } },
        { id: "openai/gpt-5.2", architecture: { output_modalities: ["text"] } }
      ]
    });

    const options = modelOptionsForNodeV1("ai.image.generate", catalog);

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      provider: "openrouter",
      providerModelId: "openai/gpt-image-1",
      storedModelId: "openai/gpt-image-1"
    });
  });

  it("does not require pricing metadata for OpenRouter image selector options", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [
        { id: "openai/gpt-image-1", architecture: { output_modalities: ["image"] }, pricing: { prompt: "0.001" } },
        { id: "google/gemini-3-pro-image-preview", architecture: { modality: "text+image->image" } },
        { id: "bytedance/seedream-5-lite", kind: "image" },
        { id: "openai/gpt-5.2", architecture: { output_modalities: ["text"] } }
      ]
    });

    const optionIds = modelOptionsForNodeV1("ai.image.generate", catalog).map((entry) => entry.storedModelId);

    expect(optionIds).toEqual([
      "bytedance/seedream-5-lite",
      "google/gemini-3-pro-image-preview",
      "openai/gpt-image-1"
    ]);
    expect(optionIds).not.toContain("openai/gpt-5.2");
  });

  it("keeps OpenRouter image options when image output is declared through modality", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [
        { id: "openai/gpt-image-1", kind: "image", architecture: { modality: "text->image" } },
        { id: "google/gemini-3-pro-image-preview", architecture: { modality: "text+image->image" } },
        { id: "openrouter/auto", architecture: { modality: "text->image" } },
        { id: "openai/gpt-5.2-chat", kind: "text", architecture: { modality: "text+image->text" } }
      ],
      fallbackModels: fallbackProviderModelsForCatalogV1()
    });

    const options = modelOptionsForNodeV1("ai.image.generate", catalog);
    const optionIds = options.map((entry) => entry.storedModelId);

    expect(optionIds).toContain("image.nano-banana");
    expect(optionIds).toContain("openai/gpt-image-1");
    expect(optionIds).toContain("google/gemini-3-pro-image-preview");
    expect(optionIds).not.toContain("openrouter/auto");
    expect(optionIds).not.toContain("openai/gpt-5.2-chat");
    expect(optionIds.length).toBeGreaterThan(1);
    expect(options.find((entry) => entry.storedModelId === "openai/gpt-image-1")?.providerModelId).toBe("openai/gpt-image-1");
  });

  it("keeps image-output OpenRouter models out of ai.text options", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [
        { id: "openai/gpt-5.2-chat", kind: "chat", architecture: { modality: "text+image->text" } },
        { id: "openai/gpt-5-image", kind: "image", architecture: { modality: "text->image", output_modalities: ["text", "image"] } },
        { id: "google/gemini-3-pro-image-preview", architecture: { modality: "text+image->image", output_modalities: ["image"] } }
      ]
    });

    const options = modelOptionsForNodeV1("ai.text", catalog);
    const optionIds = options.map((entry) => entry.storedModelId);

    expect(optionIds).toContain("openai/gpt-5.2-chat");
    expect(optionIds).not.toContain("openai/gpt-5-image");
    expect(optionIds).not.toContain("google/gemini-3-pro-image-preview");
  });

  it("does not change Polza image node filtering while adding OpenRouter image options", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [
        { id: "openai/gpt-image-1.5", type: "image", architecture: { output_modalities: ["image"] } },
        { id: "qwen/image-2", type: "image", architecture: { output_modalities: ["image"] } },
        { id: "topaz/image-upscale", type: "image", architecture: { output_modalities: ["image"] } }
      ],
      openRouterModels: [
        { id: "openai/gpt-image-1", kind: "image", architecture: { modality: "text->image" } }
      ],
      fallbackModels: fallbackProviderModelsForCatalogV1()
    });

    const options = modelOptionsForNodeV1("polza.image.generate", catalog);

    expect(options.map((entry) => entry.storedModelId)).toEqual(expect.arrayContaining(["openai/gpt-image-1.5", "openai/gpt-5.4-image-2", "qwen/image-2"]));
    expect(options.map((entry) => entry.storedModelId)).not.toContain("topaz/image-upscale");
  });

  it("keeps video upscalers out of normal Polza video generation options", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [
        { id: "kling/v3-motion-control", type: "video", inputTypes: ["text", "image"] },
        { id: "bytedance/seedance-2", type: "video", inputTypes: ["text", "image"] },
        { id: "topaz/video-upscale", type: "video" }
      ]
    });

    const options = modelOptionsForNodeV1("polza.video.generate", catalog);
    const optionIds = options.map((entry) => entry.storedModelId);

    expect(optionIds).toContain("kling/v3-motion-control");
    expect(optionIds).toContain("bytedance/seedance-2");
    expect(optionIds).not.toContain("topaz/video-upscale");
    expect(catalog.find((entry) => entry.providerModelId === "topaz/video-upscale")?.roles).toEqual(["upscaler"]);

  });

  it("fills missing live OpenRouter video inputs from curated model metadata", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [{
        id: "kwaivgi/kling-video-o1",
        kind: "video",
        architecture: { output_modalities: ["video"] }
      }]
    });

    const option = modelOptionsForNodeV1("ai.video.generate", catalog)
      .find((entry) => entry.providerModelId === "kwaivgi/kling-video-o1");

    expect(option?.inputContract?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "image", minItems: 0, maxItems: 1 })
    ]));
    expect(option?.inputRoles).toContain("sourceImage");
  });

  it("projects OpenRouter frame-image capabilities and video controls into panel options", () => {
    const catalog = assembleModelCatalogV1({
      openRouterModels: [{
        id: "kwaivgi/kling-video-o1",
        kind: "video",
        architecture: { output_modalities: ["video"] },
        supported_frame_image_modes: ["first_frame", "last_frame"],
        supported_durations: ["5", "10"],
        supported_aspect_ratios: ["16:9", "9:16"],
        supported_resolutions: ["720p"],
        generate_audio: true,
        allowed_passthrough_parameters: ["negative_prompt"]
      }]
    });

    const option = modelOptionsForNodeV1("ai.video.generate", catalog)
      .find((entry) => entry.providerModelId === "kwaivgi/kling-video-o1");
    const image = option?.inputContract?.inputs.find((input) => input.kind === "image");

    expect(image?.slots).toEqual([
      expect.objectContaining({ role: "firstFrame", maxItems: 1 }),
      expect.objectContaining({ role: "lastFrame", maxItems: 1 })
    ]);
    expect(option?.parameters.map((parameter) => parameter.id)).toEqual(expect.arrayContaining([
      "duration", "aspectRatio", "resolution", "generate_audio", "negative_prompt"
    ]));
  });

  it("uses the live provider schema for Kling 2.6 required video parameters", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [{
        id: "kling/v2.6",
        type: "video",
        top_provider: { parameters: {
          prompt: { required: true },
          aspect_ratio: { required: true, values: ["1:1", "16:9", "9:16"] },
          duration: { required: true, default: "5", values: ["5", "10"] },
          images: { min: 0, max: 1 },
          sound: { required: true, default: "false", values: ["true", "false"] }
        } }
      }]
    });

    expect(catalog[0]?.parameters).toEqual([
      expect.objectContaining({ id: "aspect_ratio", type: "select", required: true }),
      expect.objectContaining({ id: "duration", required: true, default: "5" }),
      expect.objectContaining({ id: "sound", required: true, default: "false" })
    ]);
    expect(catalog[0]?.parameters[0]?.options?.map((option) => option.value)).toEqual(["1:1", "16:9", "9:16"]);
    expect(catalog[0]?.parameters.map((field) => field.id)).not.toContain("resolution");
  });

  it("keeps WAN and HappyHorse together by enriching missing live input metadata from fallback defaults", () => {
    const catalog = assembleModelCatalogV1({
      polzaModels: [
        { id: "wan/2.6", name: "Wan 2.6", type: "video", inputTypes: [] },
        { id: "alibaba/happyhorse-1.0", name: "HappyHorse 1.0", type: "video", inputTypes: ["text", "image"] },
        { id: "text-only/video", name: "Text only", type: "video", inputTypes: ["text"] }
      ],
      fallbackModels: fallbackProviderModelsForCatalogV1()
    });
    const options = modelOptionsForNodeV1("polza.video.generate", catalog, { image: 1, video: 0, audio: 0 });
    expect(options.map((entry) => entry.providerModelId)).toEqual(["alibaba/happyhorse-1.0", "wan/2.6"]);
    expect(options.find((entry) => entry.providerModelId === "wan/2.6")?.inputTypes).toEqual(["text", "image", "video"]);
  });

  it("reports exact image-to-video compatibility exclusions", () => {
    const catalog = assembleModelCatalogV1({ polzaModels: [
      { id: "valid/video", type: "video", inputTypes: ["text", "image"] },
      { id: "text-only/video", type: "video", inputTypes: ["text"] }
    ] });
    const textOnly = catalog.find((entry) => entry.providerModelId === "text-only/video")!;
    expect(compatibilityReasonsForNodeV1("polza.video.generate", textOnly, { image: 1, video: 0, audio: 0 })).toContain("unsupported image input");
    const missingId = { ...textOnly, id: "polza:missing", providerModelId: "" };
    expect(compatibilityReasonsForNodeV1("polza.video.generate", missingId)).toContain("missing providerModelId");
    const debug = modelCompatibilityDebugForNodeV1("polza.video.generate", catalog, { image: 1, video: 0, audio: 0 });
    expect(debug.included.map((entry) => entry.providerModelId)).toEqual(["valid/video"]);
    expect(debug.excluded.find((entry) => entry.providerModelId === "text-only/video")?.reasons).toContain("unsupported image input");
    expect(debug.counts).toMatchObject({ polzaVideo: 2, polzaImageToVideo: 1, nodeCompatible: 1, final: 1 });
  });

  it("uses one shared supplied-input evaluator for Kling, Seedance, WAN, and HappyHorse", () => {
    const video = (id: string, parameters: Record<string, unknown>) => ({ id, type: "video", top_provider: { parameters } });
    const catalog = assembleModelCatalogV1({ polzaModels: [
      video("kling/v3", { images: { min: 0, max: 2 } }),
      video("bytedance/seedance-2", { images: { min: 0, max: 5 } }),
      video("wan/2.6", { images: { min: 0, max: 1 } }),
      video("alibaba/happyhorse-1.1", { images: { min: 0, max: 1 } }),
      video("kling/v3-motion-control", { images: { min: 1, max: 1 }, videos: { min: 1, max: 1 } })
    ] });
    const options = modelOptionsForNodeV1("polza.video.generate", catalog, { image: 1, video: 0, audio: 0 });
    expect(options.map((entry) => entry.providerModelId)).toEqual(expect.arrayContaining(["kling/v3", "bytedance/seedance-2", "wan/2.6", "alibaba/happyhorse-1.1"]));
    expect(options.map((entry) => entry.providerModelId)).not.toContain("kling/v3-motion-control");
  });

  it("keeps direct image fallback aliases as provider-native node options", () => {
    const catalog = assembleModelCatalogV1({
      fallbackModels: fallbackProviderModelsForCatalogV1()
    });

    const options = modelOptionsForNodeV1("ai.image.generate", catalog);
    const nanoBanana = options.find((entry) => entry.storedModelId === "image.nano-banana");

    expect(nanoBanana).toMatchObject({
      provider: "gemini",
      providerModelId: "image.nano-banana",
      storedModelId: "image.nano-banana",
      availability: { source: "fallback" }
    });
  });

  it("keeps RuTronix text models selectable even when provider pricing is missing", () => {
    const catalog = assembleModelCatalogV1({
      rutronixModels: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }]
    });
    const option = modelOptionsForNodeV1("ai.text", catalog).find((entry) => entry.provider === "rutronix");
    expect(option).toMatchObject({
      id: "rutronix:deepseek-v4-flash",
      providerModelId: "deepseek-v4-flash",
      storedModelId: "rutronix:deepseek-v4-flash",
      executionProvider: "rutronix",
      availability: { status: "available" }
    });
    expect(option?.pricing?.status ?? "missing").toBe("missing");
  });

  it("keeps provider rows for legacy clients and exposes one canonical row with executable routes", () => {
    const catalog = assembleModelCatalogV1({
      kieModels: [{ id: "kling-3.0/video", canonicalModelId: "kling-3.0-pro", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"] }],
      openRouterModels: [{ id: "kwaivgi/kling-v3.0-pro", kind: "video", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"] }]
    });
    expect(catalog).toHaveLength(2);
    const canonical = canonicalModelCatalogV1(catalog);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ id: "kling-3.0-pro", providerRoutes: [{ provider: "kie" }, { provider: "openrouter" }] });
  });

  it("groups documented KIE and OpenRouter GPT-5.2 text routes", () => {
    const catalog = assembleModelCatalogV1({
      kieModels: [{ id: "gpt-5-2", canonicalModelId: "gpt-5.2", inputTypes: ["text", "image"], outputTypes: ["text"], capabilities: ["text.generate"] }],
      openRouterModels: [{ id: "openai/gpt-5.2", kind: "chat", inputTypes: ["text", "image"], outputTypes: ["text"], capabilities: ["text.generate"] }]
    });
    const options = modelOptionsForNodeV1("ai.text", catalog);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ id: "gpt-5.2", providerRoutes: [{ provider: "kie", providerModelId: "gpt-5-2" }, { provider: "openrouter", providerModelId: "openai/gpt-5.2" }] });
  });
});
