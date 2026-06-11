import { describe, expect, it, vi } from "vitest";
import { loadModelCatalog, localProviderModelOptions, mergeModelsForDisplay, modelImageInputLimit, modelSelectionId, modelsCompatibleWithNodeInputs, modelsForContentKind, normalizeModelOptions, providerDisplayName } from "../src/modelCatalog";

describe("Living Canvas model catalog", () => {
  it("keeps the fallback image model and skips disconnected providers", async () => {
    const getJson = vi.fn();
    const catalog = await loadModelCatalog(getJson, { polza: { configured: false }, openrouter: { configured: false } });

    expect(getJson).not.toHaveBeenCalled();
    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).toContain("image.nano-banana");
  });

  it("normalizes provider image, video, and text models into compatible outputs", async () => {
    const getJson = vi.fn(async (path: string) => path.includes("capability=image.generate")
      ? [{ id: "vendor/image-model", title: "Picture Maker", providerId: "polza", capabilities: ["image.generate"], outputTypes: ["image"] }]
      : path.includes("capability=video.generate")
        ? [{ id: "vendor/video-model", title: "Movie Maker", providerId: "polza", capabilities: ["video.generate"], outputTypes: ["video"] }]
        : path.includes("capability=text.generate")
          ? [
              { id: "openai/gpt-5.2", title: "GPT 5.2", providerId: "openrouter", capabilities: ["text.generate"], outputTypes: ["text"] },
              { id: "vendor/chat-model", title: "Writer", providerId: "polza", capabilities: ["text.generate"], outputTypes: ["text"] },
              { id: "google/gemini-image-chat", title: "Vision chat", providerId: "polza", capabilities: ["text.generate"], inputTypes: ["text", "image"], outputTypes: ["text"] }
            ]
          : []);

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true }, openrouter: { configured: true } });

    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).toContain("vendor/image-model");
    expect(modelsForContentKind(catalog.models, "video").map((model) => model.id)).toEqual(["vendor/video-model"]);
    expect(modelsForContentKind(catalog.models, "text").map((model) => model.id)).toEqual(["openai/gpt-5.2", "vendor/chat-model", "google/gemini-image-chat"]);
    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).not.toContain("google/gemini-image-chat");
  });

  it("shows image-output OpenRouter models and merges equal model sources for display", async () => {
    const getJson = vi.fn(async (path: string) => path.includes("capability=image.generate")
      ? [
          { id: "openai/gpt-image-1.5", title: "GPT Image 1.5", providerId: "openrouter", capabilities: ["image.generate"], outputTypes: ["image"] },
          { id: "openai/gpt-image-1.5", title: "GPT Image 1.5", providerId: "polza", capabilities: ["image.generate"], outputTypes: ["image"] }
        ]
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
    const getJson = vi.fn(async (path: string) => path.includes("capability=video.generate")
      ? [{
            id: "kwaivgi/kling-video-o1",
            providerId: "openrouter",
            title: "Kling: Video O1",
            capabilities: ["video.generate"],
            inputTypes: ["text", "image"],
            outputTypes: ["video"],
            metadata: { description: "Supports text and image inputs with video output." }
          }]
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

  it("falls back to legacy OpenRouter video catalog when the normalized video query is empty", async () => {
    const getJson = vi.fn(async (path: string) => path === "/api/providers/openrouter/models"
      ? {
          models: [{
            id: "kwaivgi/kling-v3.0-pro",
            provider: "openrouter",
            kind: "video",
            name: "Kling: Video v3.0 Pro",
            architecture: { output_modalities: ["video"] }
          }]
        }
      : []);

    const catalog = await loadModelCatalog(getJson, { openrouter: { configured: true } });

    expect(getJson).toHaveBeenCalledWith("/api/models?provider=openrouter&capability=video.generate");
    expect(modelsForContentKind(catalog.models, "video").map((model) => model.id)).toContain("kwaivgi/kling-v3.0-pro");
  });

  it("keeps provider upscalers out of generation choices and exposes configured Replicate upscalers", async () => {
    const getJson = vi.fn(async (path: string) => path.includes("capability=image.generate")
      ? [{ id: "topaz/image-upscale", providerId: "polza", capabilities: ["image.generate"], outputTypes: ["image"] }]
      : path.includes("capability=video.generate")
        ? [{ id: "topaz/video-upscale", providerId: "polza", capabilities: ["video.generate"], outputTypes: ["video"] }]
        : []);

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true }, replicate: { configured: true } });

    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).not.toContain("topaz/image-upscale");
    expect(modelsForContentKind(catalog.models, "video").map((model) => model.id)).not.toContain("topaz/video-upscale");
    expect(catalog.models.filter((model) => model.role === "image-upscaler").map((model) => model.id)).toEqual(expect.arrayContaining(["topaz/image-upscale", "philz1337x/clarity-upscaler"]));
    expect(catalog.models.find((model) => model.id === "topaz/video-upscale")?.role).toBe("video-upscaler");
  });

  it("shows models discovered from a connected local image provider without making them executable", () => {
    const models = localProviderModelOptions({
      id: "local:http://127.0.0.1:7860",
      title: "Local SD",
      providerType: "Stable Diffusion",
      status: "connected",
      models: [{ title: "sdxl.safetensors", modelName: "sdxl" }]
    });

    expect(models).toMatchObject([{ id: "sdxl", providerId: "local:http://127.0.0.1:7860", isAvailable: false }]);
    expect(modelsForContentKind(models, "image")).toEqual([]);
  });
});
