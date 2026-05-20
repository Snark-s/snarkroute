import { describe, expect, it } from "vitest";
import { createModelResolver, resolutionMetadata, resolveModelProvider, type ModelMapping } from "./index";

const mappings: ModelMapping[] = [
  { id: "text.default", task: "text", label: "Default Text", openrouterModel: "openai/gpt-5.2", status: "supported" },
  { id: "text.direct", task: "text", label: "Direct Text", openrouterModel: null, directProvider: "gemini", directModel: "gemini-3.1-pro", routeSupport: { direct: "supported", openrouter: "unsupported" }, status: "supported" },
  { id: "text.local", task: "text", label: "Local Text", directProvider: "local", directModel: "llama-local", status: "supported" },
  { id: "image.nano-banana", task: "image", label: "Nano Banana", openrouterModel: null, directProvider: "gemini", directModel: "gemini-3.1-flash-image-preview", status: "unknown" },
  { id: "image.unsupported", task: "image", label: "No Image", openrouterModel: "openai/text-only", supportsImageGeneration: "unsupported", status: "supported" }
];

describe("@snarkroute/model-registry resolver", () => {
  it("resolves an explicit OpenRouter route", () => {
    expect(resolveModelProvider({ task: "text", modelId: "text.default", providerMode: "openrouter", mappings })).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-5.2",
      reason: "OpenRouter selected explicitly."
    });
  });

  it("resolves an explicit direct route", () => {
    expect(resolveModelProvider({ task: "text", modelId: "text.direct", providerMode: "direct", mappings })).toMatchObject({
      provider: "direct",
      directProvider: "gemini",
      model: "gemini-3.1-pro",
      reason: "Direct API selected explicitly."
    });
  });

  it("resolves an explicit local route", () => {
    expect(resolveModelProvider({ task: "text", modelId: "text.local", providerMode: "local", mappings })).toMatchObject({
      provider: "local",
      model: "llama-local",
      reason: "Local model selected."
    });
  });

  it("auto route chooses supported OpenRouter mapping", () => {
    expect(createModelResolver(mappings)({ task: "text", modelId: "text.default", providerMode: "auto" })).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-5.2"
    });
  });

  it("auto route chooses supported direct mapping when OpenRouter is unavailable", () => {
    expect(resolveModelProvider({ task: "text", modelId: "text.direct", providerMode: "auto", mappings })).toMatchObject({
      provider: "direct",
      directProvider: "gemini",
      model: "gemini-3.1-pro"
    });
  });

  it("fails image task when image generation is unsupported", () => {
    expect(() => resolveModelProvider({ task: "image", modelId: "image.unsupported", providerMode: "auto", mappings })).toThrow("This model is not available for image generation.");
  });

  it("returns expected resolution metadata", () => {
    const resolution = resolveModelProvider({ task: "text", modelId: "text.default", providerMode: "auto", mappings });
    expect(resolutionMetadata(resolution, { estimatedCostStatus: "unknown" })).toMatchObject({
      selectedModelLabel: "Default Text",
      selectedModelId: "text.default",
      selectedConnectionRoute: "auto",
      resolvedProvider: "OpenRouter",
      resolvedRoute: "openrouter",
      supportsImageGeneration: "unknown",
      localMappingRequired: true,
      mappingKeyUsed: "text.default",
      fallbackUsed: false,
      fallbackReason: null,
      requestProvider: "openrouter",
      requestModelSlug: "openai/gpt-5.2",
      estimatedCostStatus: "unknown"
    });
  });

  it("preserves OpenRouter resolver edge-case errors", () => {
    expect(() => resolveModelProvider({ task: "image", modelId: "image.nano-banana", providerMode: "openrouter", mappings })).toThrow("This model is listed in the UI but has no executable image route.");
    expect(() => resolveModelProvider({ task: "image", modelId: "openai/gpt-5.4-image-2", providerMode: "direct", mappings })).toThrow("Direct API route requires a provider mapping for openai/gpt-5.4-image-2, but none was found.");
    expect(() => resolveModelProvider({ task: "image", modelId: "openai/gpt-5.4-image-2", providerMode: "auto", mappings })).toThrow("Auto route cannot resolve this model because image support is unknown. Choose OpenRouter or Direct API explicitly.");
  });
});
