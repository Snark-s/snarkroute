import { describe, expect, it } from "vitest";
import {
  createProviderNativeStoredModelId,
  createUnifiedModelId,
  inferOriginVendorFromProviderModelId,
  normalizeProviderAvailability,
  normalizeProviderModelToV1Input
} from "../src/v1/index.js";

describe("Model Catalog V1 provider normalization", () => {
  it("keeps Polza providerModelId separate from the unified id", () => {
    const model = normalizeProviderModelToV1Input({
      provider: "polza",
      providerModelId: "openai/gpt-5.4-image-2",
      displayName: "GPT-5.4 Image 2",
      inputTypes: ["text", "image"],
      outputTypes: ["image"],
      capabilities: ["image.generate"],
      roles: ["generator"]
    });

    expect(model.id).toBe("polza:openai/gpt-5.4-image-2");
    expect(model.providerModelId).toBe("openai/gpt-5.4-image-2");
    expect(model.originVendor).toBe("openai");
  });

  it("infers origin vendors from provider model id prefixes", () => {
    expect(inferOriginVendorFromProviderModelId("qwen/image-2")).toBe("qwen");
    expect(inferOriginVendorFromProviderModelId("black-forest-labs/flux.2-flex")).toBe("black-forest-labs");
    expect(inferOriginVendorFromProviderModelId("tongyi-mai/z-image")).toBe("z-ai");
    expect(inferOriginVendorFromProviderModelId("x-ai/grok-image")).toBe("x-ai");
    expect(inferOriginVendorFromProviderModelId("kwaivgi/kling-video-o1")).toBe("kling");
    expect(inferOriginVendorFromProviderModelId("kling-3.0/video")).toBe("kling");
    expect(inferOriginVendorFromProviderModelId("image.nano-banana")).toBe("nano-banana");
    expect(inferOriginVendorFromProviderModelId("google/gemini-3.1-flash-image-preview")).toBe("nano-banana");
    expect(inferOriginVendorFromProviderModelId("google/gemini-3-pro-image-preview")).toBe("nano-banana");
    expect(inferOriginVendorFromProviderModelId("google/gemini-3-pro")).toBe("google");
  });

  it("represents unknown live provider models as available live records", () => {
    const model = normalizeProviderModelToV1Input({
      provider: "unknown-provider",
      providerModelId: "vendor/new-model",
      metadata: { raw: true }
    });

    expect(model.availability).toMatchObject({ status: "available", source: "live" });
    expect(model.provider).toBe("unknown-provider");
    expect(model.id).toBe("unknown-provider:vendor/new-model");
  });

  it("does not require node compatibility at provider normalization stage", () => {
    const model = normalizeProviderModelToV1Input({
      provider: "openrouter",
      providerModelId: "vendor/model"
    });

    expect("nodeType" in model).toBe(false);
    expect("storedModelId" in model).toBe(false);
    expect("nodeCompatibility" in model).toBe(false);
  });

  it("creates provider-native stored model ids separately from unified ids", () => {
    expect(createUnifiedModelId("polza", "openai/gpt-5.4-image-2")).toBe("polza:openai/gpt-5.4-image-2");
    expect(createProviderNativeStoredModelId("openai/gpt-5.4-image-2")).toBe("openai/gpt-5.4-image-2");
  });

  it("normalizes provider availability defaults and overrides", () => {
    expect(normalizeProviderAvailability()).toMatchObject({ status: "available", source: "live" });
    expect(normalizeProviderAvailability({ status: "unknown", source: "cache", configured: false })).toMatchObject({
      status: "unknown",
      source: "cache",
      configured: false
    });
  });
});
