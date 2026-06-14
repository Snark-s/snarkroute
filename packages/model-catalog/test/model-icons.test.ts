import { describe, expect, it } from "vitest";
import { createModelIconResolver } from "../src/index";

describe("shared model icon resolver", () => {
  const resolver = createModelIconResolver("http://localhost:4317");

  it("resolves model families before execution providers", () => {
    expect(resolver.modelLogoFor("polza", "tongyi-mai/z-image").src).toContain("/api/model-icons/z-image.png");
    expect(resolver.modelLogoFor("openrouter", "x-ai/grok-image").src).toContain("/api/model-icons/grok-image.png");
    expect(resolver.modelLogoFor("polza", "qwen/qwen-image").src).toContain("/api/model-icons/qwen.png");
  });

  it("keeps provider icons as a fallback only", () => {
    expect(resolver.modelLogoFor("polza", "custom-model").src).toContain("/api/model-icons/polza.svg");
    expect(resolver.modelLogoFor("openrouter", "custom-model").src).toContain("/api/model-icons/openrouter.svg");
  });

  it("ignores provider icon paths in catalog options when identity metadata is available", () => {
    expect(resolver.modelLogoForCatalogOption({
      providerId: "polza",
      providerModelId: "google/gemini-3-pro-image-preview",
      iconPath: "/api/model-icons/polza.svg",
      title: "Gemini Image"
    }).src).toContain("/api/model-icons/nano-banana.svg");
  });
});
