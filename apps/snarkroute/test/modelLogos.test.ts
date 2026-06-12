import { describe, expect, it } from "vitest";
import { modelLogoFor, modelLogoForCatalogOption, modelLogoRegistry } from "../src/modelLogos";

describe("Living Canvas model logos", () => {
  it("uses the model family registry before provider fallbacks", () => {
    expect(modelLogoRegistry.map((entry) => entry.family)).toEqual(expect.arrayContaining(["Kling", "Wan", "MiniMax / Hailuo", "ByteDance Seedance", "Nano Banana"]));
    expect(modelLogoFor("openrouter", "kwaivgi/kling-v3.0-pro").label).toBe("Kling");
    expect(modelLogoFor("openrouter", "minimax/hailuo-2.3").label).toBe("MiniMax");
    expect(modelLogoFor("openrouter", "minimax/hailuo-2.3").src).toContain("/api/model-icons/hailuo.png");
    expect(modelLogoFor("gemini", "image.nano-banana").label).toBe("Nano Banana");
    expect(modelLogoFor("gemini", "image.nano-banana").src).toContain("/api/model-icons/gemini.png");
    expect(modelLogoFor("gemini", "gemini-3.1-flash-image-preview").label).toBe("Nano Banana");
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
      iconPath: "/api/model-icons/vendor.svg"
    })).toMatchObject({
      label: "Vendor Model",
      src: "http://127.0.0.1:4317/api/model-icons/vendor.svg"
    });

    expect(modelLogoForCatalogOption({
      providerId: "openrouter",
      id: "kwaivgi/kling-v3.0-pro",
      title: "Kling should not be inferred"
    })).toMatchObject({
      label: "OpenRouter",
      src: "http://127.0.0.1:4317/api/model-icons/openrouter.svg"
    });

    expect(modelLogoForCatalogOption({
      providerId: "",
      id: "vendor/model",
      title: "Unknown"
    }).src).toContain("/api/model-icons/unknown.svg");
  });
});
