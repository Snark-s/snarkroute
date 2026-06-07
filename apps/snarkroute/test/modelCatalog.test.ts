import { describe, expect, it, vi } from "vitest";
import { loadModelCatalog, localProviderModelOptions, mergeModelsForDisplay, modelsForContentKind, providerDisplayName } from "../src/modelCatalog";

describe("Living Canvas model catalog", () => {
  it("keeps the fallback image model and skips disconnected providers", async () => {
    const getJson = vi.fn();
    const catalog = await loadModelCatalog(getJson, { polza: { configured: false }, openrouter: { configured: false } });

    expect(getJson).not.toHaveBeenCalled();
    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).toContain("image.nano-banana");
  });

  it("normalizes provider image, video, and text models into compatible outputs", async () => {
    const getJson = vi.fn(async (path: string) => path.includes("type=image")
      ? { models: [{ id: "vendor/image-model", title: "Picture Maker", type: "image-generation" }] }
      : path.includes("type=video")
        ? { models: [{ id: "vendor/video-model", title: "Movie Maker", type: "video" }] }
        : path.includes("type=chat")
          ? { models: [{ id: "vendor/chat-model", title: "Writer", type: "chat" }, { id: "google/gemini-image-chat", title: "Vision chat", type: "chat" }] }
          : { models: [{ id: "openai/gpt-5.2" }] });

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true }, openrouter: { configured: true } });

    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).toContain("vendor/image-model");
    expect(modelsForContentKind(catalog.models, "video").map((model) => model.id)).toEqual(["vendor/video-model"]);
    expect(modelsForContentKind(catalog.models, "text").map((model) => model.id)).toEqual(["openai/gpt-5.2", "vendor/chat-model", "google/gemini-image-chat"]);
    expect(modelsForContentKind(catalog.models, "image").map((model) => model.id)).not.toContain("google/gemini-image-chat");
  });

  it("shows image-output OpenRouter models and merges equal model sources for display", async () => {
    const getJson = vi.fn(async (path: string) => path.includes("openrouter")
      ? { models: [{ id: "openai/gpt-image-1.5", title: "GPT Image 1.5", architecture: { output_modalities: ["image"] } }] }
      : path.includes("type=image")
        ? { models: [{ id: "openai/gpt-image-1.5", title: "GPT Image 1.5", type: "image" }] }
        : { models: [] });

    const catalog = await loadModelCatalog(getJson, { polza: { configured: true }, openrouter: { configured: true } });
    const rows = mergeModelsForDisplay(modelsForContentKind(catalog.models, "image"));
    const shared = rows.find((entry) => entry.model.id === "openai/gpt-image-1.5");

    expect(shared?.providers.map(providerDisplayName).join(", ")).toBe("OpenRouter, polza.ai");
    expect(shared?.routes.map((route) => route.providerId)).toEqual(["openrouter", "polza"]);
  });

  it("keeps provider upscalers out of generation choices and exposes configured Replicate upscalers", async () => {
    const getJson = vi.fn(async (path: string) => path.includes("type=image")
      ? { models: [{ id: "topaz/image-upscale", type: "image" }] }
      : path.includes("type=video")
        ? { models: [{ id: "topaz/video-upscale", type: "video" }] }
        : { models: [] });

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
