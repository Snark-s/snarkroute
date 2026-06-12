import { describe, expect, it, vi } from "vitest";
import { loadModelCatalog, mergeModelsForDisplay, mergeProviderAndUserDefinedPickerModels, modelImageInputLimit, modelSelectionId, modelsCompatibleWithNodeInputs, modelsForContentKind, modelsForPickerContentKind, normalizeModelOptions, providerDisplayName } from "../src/modelCatalog";
import type { ModelOption } from "../src/modelCatalog";

function v1Model(overrides: {
  provider?: string;
  providerModelId: string;
  originVendor?: string;
  displayName?: string;
  iconKey?: string;
  iconPath?: string;
  inputTypes?: string[];
  outputTypes: string[];
  capabilities?: string[];
  roles?: string[];
}) {
  return {
    id: `${overrides.provider ?? "polza"}:${overrides.providerModelId}`,
    provider: overrides.provider ?? "polza",
    providerModelId: overrides.providerModelId,
    originVendor: overrides.originVendor,
    displayName: overrides.displayName ?? overrides.providerModelId,
    iconKey: overrides.iconKey,
    iconPath: overrides.iconPath ?? "/icons/model.svg",
    inputTypes: overrides.inputTypes ?? ["text"],
    outputTypes: overrides.outputTypes,
    capabilities: overrides.capabilities ?? [],
    roles: overrides.roles ?? [],
    parameters: [],
    availability: { status: "available" }
  };
}

describe("Living Canvas model catalog", () => {
  it("keeps the fallback image model and skips disconnected providers", async () => {
    const getJson = vi.fn();
    const catalog = await loadModelCatalog(getJson, { polza: { configured: false }, openrouter: { configured: false } });

    expect(getJson).toHaveBeenCalledWith("/api/models/v1");
    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).toContain("image.nano-banana");
  });

  it("uses V1 output types for generic rendered picker choices", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/models/v1"
      ? { models: [
          v1Model({ provider: "openrouter", providerModelId: "openai/gpt-5.1", displayName: "GPT 5.1", inputTypes: ["text", "image"], outputTypes: ["text"], capabilities: ["text.generate"] }),
          v1Model({ provider: "openrouter", providerModelId: "openai/gpt-5.1-codex-mini", displayName: "GPT 5.1 Codex Mini", outputTypes: ["text"], capabilities: ["text.generate"] }),
          v1Model({ provider: "openrouter", providerModelId: "openai/gpt-5.2", displayName: "GPT 5.2", outputTypes: ["text"], capabilities: ["text.generate"] }),
          v1Model({ provider: "openrouter", providerModelId: "openai/gpt-5.2-chat", displayName: "GPT 5.2 Chat", outputTypes: ["text"], capabilities: ["text.generate"] }),
          v1Model({ provider: "openrouter", providerModelId: "openai/gpt-5.2-mixed-output", displayName: "GPT 5.2 Mixed", outputTypes: ["text", "image"], capabilities: ["text.generate"] }),
          v1Model({ provider: "polza", providerModelId: "openai/gpt-5.4-image-2", displayName: "GPT Image", outputTypes: ["image"], capabilities: ["image.generate"] }),
          v1Model({ provider: "polza", providerModelId: "qwen/image-2", displayName: "Qwen Image", outputTypes: ["image"], capabilities: ["image.generate"] }),
          v1Model({ provider: "polza", providerModelId: "yandex/yandex-art", displayName: "Yandex Art", outputTypes: ["image"], capabilities: ["image.generate"] }),
          v1Model({ provider: "openrouter", providerModelId: "google/veo-3", displayName: "Veo 3", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"] })
        ] }
      : []);

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true }, openrouter: { configured: true } });
    const imageIds = modelsForPickerContentKind(catalog.availableModels, "image").map((model) => model.id);
    const videoIds = modelsForPickerContentKind(catalog.availableModels, "video").map((model) => model.id);
    const textIds = modelsForPickerContentKind(catalog.availableModels, "text").map((model) => model.id);

    expect(imageIds).toEqual(["openai/gpt-5.2-mixed-output", "openai/gpt-5.4-image-2", "qwen/image-2", "yandex/yandex-art"]);
    expect(imageIds).not.toEqual(expect.arrayContaining(["openai/gpt-5.1", "openai/gpt-5.1-codex-mini", "openai/gpt-5.2", "openai/gpt-5.2-chat"]));
    expect(videoIds).toEqual(["google/veo-3"]);
    expect(textIds).toEqual(["openai/gpt-5.1", "openai/gpt-5.1-codex-mini", "openai/gpt-5.2", "openai/gpt-5.2-chat"]);
    expect(textIds).not.toEqual(expect.arrayContaining(["openai/gpt-5.2-mixed-output", "openai/gpt-5.4-image-2", "qwen/image-2", "yandex/yandex-art", "google/veo-3"]));
    expect(catalog.models.map((model) => model.id)).not.toContain("image.nano-banana");
    expect(getJson).not.toHaveBeenCalledWith("/api/models/for-node/ai.image.generate");
    expect(getJson).not.toHaveBeenCalledWith("/api/models?provider=openrouter&capability=image.generate");
    expect(getJson).not.toHaveBeenCalledWith("/api/providers/openrouter/models");
    expect(getJson).not.toHaveBeenCalledWith("/api/providers/polza/models?type=image");
  });

  it("keeps user-defined custom models as a separate picker source outside provider catalog truth", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/models/v1"
      ? { models: [
          v1Model({ provider: "polza", providerModelId: "vendor/image-model", outputTypes: ["image"] })
        ] }
      : []);
    const customModels: ModelOption[] = [{
      id: "custom:https://example.test/model",
      title: "Custom Image Model",
      providerId: "custom",
      source: "custom-link",
      contentKinds: ["image"],
      accepts: ["text"],
      produces: ["image"],
      capabilities: ["image.generate"],
      isAvailable: true
    }, {
      id: "custom:https://example.test/unknown",
      title: "Unknown Custom Model",
      providerId: "custom",
      source: "custom-link",
      contentKinds: [],
      accepts: ["text"],
      produces: [],
      capabilities: [],
      isAvailable: true
    }];

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true } });
    const pickerModels = mergeProviderAndUserDefinedPickerModels(catalog.availableModels, customModels);

    expect(catalog.availableModels.map((model) => model.id)).toEqual(["vendor/image-model"]);
    expect(modelsForPickerContentKind(pickerModels, "image").map((model) => model.id)).toEqual(["vendor/image-model", "custom:https://example.test/model"]);
    expect(modelsForPickerContentKind(pickerModels, "image").map((model) => model.id)).not.toContain("custom:https://example.test/unknown");
  });

  it("feeds the actual generic video picker from V1 video models without requiring iconPath", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/models/v1"
      ? { models: [
          v1Model({ provider: "openrouter", providerModelId: "vendor/live-video", displayName: "Live Video", iconPath: "", iconKey: "openrouter", outputTypes: ["video"] }),
          v1Model({ provider: "polza", providerModelId: "vendor/video-upscale", iconPath: "", outputTypes: ["video"], roles: ["upscaler"] }),
          v1Model({ provider: "polza", providerModelId: "vendor/image-model", outputTypes: ["image"] })
        ] }
      : []);

    const catalog = await loadModelCatalog(getJson, { openrouter: { configured: true }, polza: { configured: true } });

    expect(modelsForPickerContentKind(catalog.availableModels, "Video").map((model) => model.id)).toEqual(["vendor/live-video"]);
    expect(modelsForPickerContentKind(catalog.availableModels, "movingImage").map((model) => model.id)).toEqual(["vendor/live-video"]);
    expect(modelsForPickerContentKind(catalog.availableModels, "clip").map((model) => model.id)).toEqual(["vendor/live-video"]);
    expect(modelsForPickerContentKind(catalog.availableModels, "media")).toEqual([]);
  });

  it("keeps V1 iconPath when provided and assigns safe fallback icon paths otherwise", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/models/v1"
      ? { models: [
          v1Model({ providerModelId: "vendor/with-icon", iconPath: "/api/model-icons/custom.svg", outputTypes: ["image"] }),
          v1Model({ provider: "openrouter", providerModelId: "vendor/from-icon-key", iconPath: "", iconKey: "openrouter", outputTypes: ["video"] }),
          v1Model({ provider: "polza", providerModelId: "vendor/from-origin", iconPath: "", originVendor: "openai", outputTypes: ["text"] }),
          v1Model({ provider: "polza", providerModelId: "vendor/from-provider", iconPath: "", outputTypes: ["text"] })
        ] }
      : []);

    const catalog = await loadModelCatalog(getJson, {});

    expect(catalog.availableModels.find((model) => model.id === "vendor/with-icon")?.iconPath).toBe("/api/model-icons/custom.svg");
    expect(catalog.availableModels.find((model) => model.id === "vendor/from-icon-key")?.iconPath).toBe("/api/model-icons/openrouter.svg");
    expect(catalog.availableModels.find((model) => model.id === "vendor/from-origin")?.iconPath).toBe("/api/model-icons/gpt.png");
    expect(catalog.availableModels.find((model) => model.id === "vendor/from-provider")?.iconPath).toBe("/api/model-icons/polza.svg");
    expect(catalog.availableModels.every((model) => typeof model.iconPath === "string" && model.iconPath.length > 0)).toBe(true);
  });

  it("shows image-output OpenRouter models and merges equal model sources for display", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/models/v1"
      ? { models: [
          v1Model({ provider: "openrouter", providerModelId: "openai/gpt-image-1.5", displayName: "GPT Image 1.5", outputTypes: ["image"], capabilities: ["image.generate"] }),
          v1Model({ provider: "polza", providerModelId: "openai/gpt-image-1.5", displayName: "GPT Image 1.5", outputTypes: ["image"], capabilities: ["image.generate"] })
        ] }
      : []);

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true }, openrouter: { configured: true } });
    const rows = mergeModelsForDisplay(modelsForContentKind(catalog.models, "image"));
    const shared = rows.find((entry) => entry.model.id === "openai/gpt-image-1.5");

    expect(shared?.providers.map(providerDisplayName).join(", ")).toBe("OpenRouter, polza.ai");
    expect(shared?.routes.map((route) => route.providerId)).toEqual(["openrouter", "polza"]);
  });

  it("hides OpenRouter routing aliases from concrete model choices", () => {
    const models = normalizeModelOptions([{
      id: "openrouter/auto",
      title: "Auto Router",
      providerId: "openrouter",
      capabilities: ["text.generate"],
      outputTypes: ["text"]
    }, {
      id: "openai/gpt-5.2-chat",
      title: "OpenAI: GPT-5.2 Chat",
      providerId: "openrouter",
      capabilities: ["text.generate"],
      outputTypes: ["text"]
    }], "openrouter");

    expect(models.map((model) => model.id)).toEqual(["openai/gpt-5.2-chat"]);
  });

  it("does not expose text-to-image models in text node choices", () => {
    const models = normalizeModelOptions([{
      id: "vendor/text-to-image",
      title: "Image Generator",
      providerId: "polza",
      outputTypes: ["text-to-image"],
      inputTypes: ["text"]
    }, {
      id: "vendor/chat",
      title: "Chat Writer",
      providerId: "polza",
      outputTypes: ["text"],
      inputTypes: ["text"]
    }], "polza");

    expect(modelsForContentKind(models, "image").map((model) => model.id)).toContain("vendor/text-to-image");
    expect(modelsForContentKind(models, "text").map((model) => model.id)).toEqual(["vendor/chat"]);
  });

  it("keeps image-output models out of text choices even when a provider lists text capability", () => {
    const models = normalizeModelOptions([{
      id: "openai/gpt-5.4-image-2",
      title: "OpenAI: GPT-5.4 Image 2",
      providerId: "openrouter",
      capabilities: ["text.generate", "image.generate"],
      outputTypes: ["image"],
      inputTypes: ["text", "image"]
    }, {
      id: "openai/gpt-5.2",
      title: "OpenAI: GPT-5.2",
      providerId: "openrouter",
      capabilities: ["text.generate"],
      outputTypes: ["text"],
      inputTypes: ["text"]
    }], "openrouter");

    expect(modelsForContentKind(models, "text").map((model) => model.id)).toEqual(["openai/gpt-5.2"]);
    expect(modelsForContentKind(models, "image").map((model) => model.id)).toEqual(["openai/gpt-5.4-image-2"]);
  });

  it("keeps all image generators in image nodes even when the node already has an image", () => {
    const imageModels = normalizeModelOptions([{
      id: "qwen/qwen-image",
      title: "Qwen Image",
      providerId: "polza",
      capabilities: ["image.generate"],
      outputTypes: ["image"]
    }, {
      id: "google/gemini-3.1-flash-image-preview",
      title: "Google: Nano Banana 2",
      providerId: "openrouter",
      capabilities: ["image.generate"],
      inputTypes: ["text", "image"],
      outputTypes: ["image"]
    }], "polza");

    expect(modelsCompatibleWithNodeInputs(imageModels, "image", true).map((model) => model.id)).toEqual([
      "qwen/qwen-image",
      "google/gemini-3.1-flash-image-preview"
    ]);
  });

  it("treats image inputs as unsupported when an image model is text-only", () => {
    const [textToImage, imageToImage] = normalizeModelOptions([{
      id: "qwen/qwen-image",
      title: "Qwen Image",
      providerId: "polza",
      capabilities: ["image.generate"],
      inputTypes: ["text"],
      outputTypes: ["image"]
    }, {
      id: "google/gemini-3.1-flash-image-preview",
      title: "Google: Nano Banana 2",
      providerId: "openrouter",
      capabilities: ["image.generate"],
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      maxImageInputs: 2
    }], "polza");

    expect(modelImageInputLimit(textToImage)).toBe(0);
    expect(modelImageInputLimit(imageToImage)).toBe(2);
  });

  it("keeps OpenRouter image-to-video models selectable for video nodes with image inputs", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/models/v1"
      ? { models: [
          v1Model({
            provider: "openrouter",
            providerModelId: "kwaivgi/kling-video-o1",
            displayName: "Kling: Video O1",
            capabilities: ["video.generate"],
            inputTypes: ["text", "image"],
            outputTypes: ["video"]
          })
        ] }
      : []);

    const catalog = await loadModelCatalog(getJson, { openrouter: { configured: true } });
    const videoModels = modelsForContentKind(catalog.models, "video");
    const klingO1 = videoModels.find((model) => model.id === "kwaivgi/kling-video-o1");

    expect(klingO1).toMatchObject({
      providerId: "openrouter",
      acceptsImageInput: true
    });
    expect(klingO1?.accepts).toContain("image");
    expect(modelSelectionId(klingO1)).toBe("openrouter:kwaivgi/kling-video-o1");
  });

  it("keeps normalized OpenRouter image-to-video models compatible when image support is only in metadata", () => {
    const models = modelsForContentKind(normalizeModelOptions([{
      id: "kwaivgi/kling-v3.0-pro",
      providerId: "openrouter",
      title: "Kling: Video v3.0 Pro",
      capabilities: ["video.generate"],
      inputTypes: ["text"],
      outputTypes: ["video"],
      metadata: { description: "Supports text-to-video and image-to-video workflows, with first-frame and last-frame control." }
    }], "openrouter"), "video");

    expect(models[0]).toMatchObject({
      id: "kwaivgi/kling-v3.0-pro",
      acceptsImageInput: true
    });
    expect(models[0].accepts).toContain("image");
  });

  it("keeps normalized Polza video models compatible when image support is exposed as maxImageInputs metadata", () => {
    const models = modelsForContentKind(normalizeModelOptions([{
      id: "wan/2.6",
      providerId: "polza",
      title: "Wan 2.6",
      capabilities: ["video.generate"],
      inputTypes: ["text"],
      outputTypes: ["video"],
      metadata: { maxImageInputs: 2 }
    }], "polza"), "video");

    expect(models[0]).toMatchObject({
      id: "wan/2.6",
      providerId: "polza",
      acceptsImageInput: true,
      maxImageInputs: 2
    });
    expect(models[0].accepts).toContain("image");
  });

  it("keeps provider upscalers out of generation choices and exposes configured Replicate upscalers", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/models/v1"
      ? { models: [
          v1Model({ providerModelId: "topaz/image-upscale", outputTypes: ["image"], capabilities: ["image.generate"], roles: ["upscaler"] }),
          v1Model({ providerModelId: "topaz/video-upscale", outputTypes: ["video"], capabilities: ["video.generate"], roles: ["upscaler"] })
        ] }
      : []);

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true }, replicate: { configured: true } });

    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).not.toContain("topaz/image-upscale");
    expect(modelsForContentKind(catalog.models, "video").map((model) => model.id)).not.toContain("topaz/video-upscale");
    expect(catalog.models.filter((model) => model.role === "image-upscaler").map((model) => model.id)).toEqual(["topaz/image-upscale"]);
    expect(catalog.models.find((model) => model.id === "topaz/video-upscale")?.role).toBe("video-upscaler");
  });

});
