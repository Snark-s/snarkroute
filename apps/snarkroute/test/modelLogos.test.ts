import { describe, expect, it } from "vitest";
import { modelLogoFor, modelLogoForCatalogOption, modelLogoRegistry } from "../src/modelLogos";

describe("Living Canvas model logos", () => {
  it("uses the model family registry before provider fallbacks", () => {
    expect(modelLogoRegistry.map((entry) => entry.family)).toEqual(expect.arrayContaining(["Kling", "Wan", "MiniMax / Hailuo", "ByteDance Seedance", "Nano Banana"]));
    expect(modelLogoFor("openrouter", "kwaivgi/kling-v3.0-pro").label).toBe("Kling");
    expect(modelLogoFor("openrouter", "minimax/hailuo-2.3").label).toBe("MiniMax");
    expect(modelLogoFor("openrouter", "minimax/hailuo-2.3").src).toContain("/api/model-icons/hailuo.png");
    expect(modelLogoFor("gemini", "image.nano-banana").label).toBe("Nano Banana");
    expect(modelLogoFor("gemini", "image.nano-banana").src).toContain("/api/model-icons/nano-banana.svg");
    expect(modelLogoFor("gemini", "gemini-3.1-flash-image-preview").label).toBe("Nano Banana");
    expect(modelLogoFor("gemini", "gemini-3-pro-image-preview").src).toContain("/api/model-icons/nano-banana.svg");
    expect(modelLogoFor("gemini", "gemini-3-pro").src).toContain("/api/model-icons/gemini.png");
    expect(modelLogoFor("polza", "wan/2.6").label).toBe("Wan");
    expect(modelLogoFor("polza", "wan/2.6").src).toContain("/api/model-icons/wan.svg");
    expect(modelLogoFor("polza", "kling/v3").label).toBe("Kling");
    expect(modelLogoFor("polza", "kling/v3").src).toContain("/api/model-icons/kling.png");
    expect(modelLogoFor("polza", "bytedance/seedance-2").label).toBe("ByteDance");
    expect(modelLogoFor("polza", "bytedance/seedance-2").src).toContain("/api/model-icons/seedream-4-5.png");
    expect(modelLogoFor("polza", "yandex/yandex-art").label).toBe("Yandex");
    expect(modelLogoFor("polza", "yandex/yandex-art").src).toContain("/api/model-icons/yandexart.png");
    expect(modelLogoFor("openrouter", "deepseek/deepseek-chat").src).toContain("/api/model-icons/deepseek.png");
    expect(modelLogoFor("openrouter", "google/veo-3").src).toContain("/api/model-icons/veo.png");
    expect(modelLogoFor("openrouter", "openai/sora-2").src).toContain("/api/model-icons/sora.png");
  });

  it("resolves V1 catalog icon paths and falls back without model-name inference", () => {
    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "vendor/model",
      title: "Vendor Model",
      iconPath: "/api/model-icons/polza.svg"
    })).toMatchObject({
      label: "Vendor Model",
      src: "http://127.0.0.1:4317/api/model-icons/unknown.svg"
    });

    expect(modelLogoForCatalogOption({
      providerId: "openrouter",
      id: "kwaivgi/kling-v3.0-pro",
      title: "Kling should not be inferred"
    })).toMatchObject({
      label: "Kling should not be inferred",
      src: "http://127.0.0.1:4317/api/model-icons/kling.png"
    });

    expect(modelLogoForCatalogOption({
      providerId: "",
      id: "vendor/model",
      title: "Unknown"
    }).src).toContain("/api/model-icons/unknown.svg");
  });

  it("falls back from missing V1 model icon files to existing vendor/provider icons", () => {
    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "qwen/image",
      title: "Qwen Image",
      iconPath: "/api/model-icons/qwen.svg",
      iconKey: "qwen",
      originVendor: "qwen"
    })).toMatchObject({
      label: "Qwen Image",
      src: "http://127.0.0.1:4317/api/model-icons/qwen.png"
    });

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "google/gemini-3.1-flash-image-preview",
      title: "Nano Banana 2",
      iconPath: "/api/model-icons/nano-banana.svg",
      iconKey: "nano-banana",
      originVendor: "nano-banana"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/nano-banana.svg");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "bytedance/seedream-5-lite",
      title: "Seedream",
      originVendor: "bytedance"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/seedream-4-5.png");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "tongyi-mai/z-image",
      title: "Z-Image",
      iconPath: "/api/model-icons/polza.svg"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/z-image.png");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "x-ai/grok-image",
      title: "Grok Image",
      iconPath: "/api/model-icons/polza.svg"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/grok-image.png");

    expect(modelLogoForCatalogOption({
      providerId: "openrouter",
      id: "google/gemini-3.1-flash-image-preview",
      title: "Nano Banana",
      iconPath: "/api/model-icons/openrouter.svg"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/nano-banana.svg");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "unlisted/model",
      title: "Unknown",
      iconPath: "/api/model-icons/polza.svg"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/unknown.svg");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "qwen/image",
      title: "Qwen with provider icon key",
      iconKey: "polza",
      originVendor: "qwen"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/qwen.png");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "kling/v3-motion-control",
      title: "Kling with provider icon key",
      iconKey: "polza",
      originVendor: "kling"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/kling.png");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "bytedance/seedance-2",
      title: "Seedance with provider icon key",
      iconKey: "polza",
      originVendor: "bytedance"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/seedream-4-5.png");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "topaz/video-upscale",
      title: "Topaz with provider icon key",
      iconKey: "polza",
      originVendor: "topaz"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/topaz.svg");

    expect(modelLogoForCatalogOption({
      providerId: "gemini",
      id: "image.nano-banana",
      title: "Nano Banana",
      iconKey: "nano-banana",
      originVendor: "nano-banana"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/nano-banana.svg");

    expect(modelLogoForCatalogOption({
      providerId: "polza",
      id: "anthropic/claude-opus-4.7-fast",
      title: "Claude",
      originVendor: "anthropic"
    }).src).toBe("http://127.0.0.1:4317/api/model-icons/claude.png");
  });
});
