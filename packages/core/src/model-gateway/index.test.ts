import { describe, expect, it, vi } from "vitest";
import { estimateCatalogPricingQuote, getModelIOContract, ModelGateway, ModelRegistry, modelSatisfiesIOContract, type ProviderAdapter } from "./index";

const models = [
  { id: "fast-text", providerId: "mock", title: "Fast Text", capabilities: ["text.generate"], speedHint: "fast" },
  { id: "image-one", providerId: "mock", title: "Image One", capabilities: ["image.generate"] }
];

describe("Model Gateway v0", () => {
  it("registry finds models by capability", () => {
    const registry = new ModelRegistry([...models]);
    expect(registry.findByCapability("text.generate")).toHaveLength(1);
  });

  it("registry finds models by modelRef", () => {
    const registry = new ModelRegistry([...models]);
    expect(registry.findByModelRef("model://mock/fast-text")?.id).toBe("fast-text");
  });

  it("resolver chooses explicit modelRef", async () => {
    const gateway = new ModelGateway({ models: [...models], adapters: [mockAdapter()], connections: [{ providerId: "mock", enabled: true, credentialRef: "provider.mock.default" }] });
    await expect(gateway.invoke({ capability: "text.generate", modelRef: "model://mock/fast-text", input: { prompt: "hi" } })).resolves.toMatchObject({ modelId: "fast-text" });
  });

  it("resolver chooses fallback model by capability", async () => {
    const gateway = new ModelGateway({ models: [...models], adapters: [mockAdapter()], connections: [{ providerId: "mock", enabled: true, credentialRef: "provider.mock.default" }] });
    await expect(gateway.invoke({ capability: "image.generate", input: { prompt: "draw" } })).resolves.toMatchObject({ modelId: "image-one" });
  });

  it("gateway invokes the correct provider adapter", async () => {
    const invoke = vi.fn(async (request) => ({ modelId: request.model.id, providerId: request.model.providerId, capability: request.capability, output: { ok: true } }));
    const gateway = new ModelGateway({
      models: [...models],
      adapters: [mockAdapter(invoke)],
      connections: [{ providerId: "mock", enabled: true, credentialRef: "provider.mock.default" }]
    });
    await gateway.invoke({ capability: "text.generate", input: { prompt: "hi" } });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ model: expect.objectContaining({ id: "fast-text" }) }), expect.objectContaining({ credentialRef: "provider.mock.default" }));
  });

  it("returns a clear error when capability is unsupported", async () => {
    const gateway = new ModelGateway({ models: [...models], adapters: [mockAdapter()], connections: [{ providerId: "mock", enabled: true, credentialRef: "provider.mock.default" }] });
    await expect(gateway.invoke({ capability: "audio.transcribe", input: {} })).rejects.toThrow('Model Gateway could not find an enabled model for capability "audio.transcribe".');
  });

  it("provider connection rejects raw API keys in node settings-shaped objects", () => {
    expect(() => new ModelGateway({
      connections: [{ providerId: "mock", enabled: true, apiKey: "sk-test" } as never]
    })).toThrow('ProviderConnection must use credentialRef/secretRef instead of carrying "apiKey".');
  });

  it("quotes the selected route without invoking the provider", () => {
    const invoke = vi.fn();
    const gateway = new ModelGateway({
      models: [{ id: "image-one", providerId: "mock", title: "Image One", capabilities: ["image.generate"] }],
      adapters: [mockAdapter(invoke)],
      connections: [{ providerId: "mock", enabled: true, credentialRef: "provider.mock.default" }]
    });
    const quote = gateway.quoteSelectedRoute({
      capability: "image.generate",
      input: { prompt: "draw" },
      parameters: { n: 3 },
      metadata: { logicalModel: "image.test" }
    });
    expect(quote).toMatchObject({ logicalModel: "image.test", provider: "mock", providerModel: "image-one", estimatedCost: 0.06, confidence: "exact" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("unknown pricing returns null estimate without failing", () => {
    const quote = estimateCatalogPricingQuote({
      provider: "mock",
      providerModel: "text",
      capability: "text.generate",
      params: {},
      inputMetadata: {}
    }, undefined, "mock_catalog");
    expect(quote).toMatchObject({ estimatedCost: null, confidence: "unknown", pricingSource: "mock_catalog" });
  });

  it("per-image and per-request catalog pricing multiply by n", () => {
    const imageQuote = estimateCatalogPricingQuote({
      provider: "mock",
      providerModel: "image",
      capability: "image.generate",
      params: { n: 2 },
      inputMetadata: {}
    }, { image: "0.05" }, "mock_catalog");
    expect(imageQuote).toMatchObject({ estimatedCost: 0.1, unit: "image" });

    const requestQuote = estimateCatalogPricingQuote({
      provider: "mock",
      providerModel: "image",
      capability: "image.generate",
      params: { n: 4 },
      inputMetadata: {}
    }, { request: 0.01 }, "mock_catalog");
    expect(requestQuote).toMatchObject({ estimatedCost: 0.04, unit: "request" });
  });

  it("quote output strips secret-shaped keys", () => {
    const quote = estimateCatalogPricingQuote({
      provider: "mock",
      providerModel: "image",
      capability: "image.generate",
      params: { n: 1, apiKey: "sk-test", token: "tok" },
      inputMetadata: { secret: "hidden", password: "hidden" }
    }, { image: 0.02, token: "tok" }, "mock_catalog");
    expect(JSON.stringify(quote)).not.toContain("sk-test");
    expect(JSON.stringify(quote)).not.toContain("tok");
    expect(JSON.stringify(quote)).not.toContain("hidden");
  });

  it("matches a model with an explicit text and image IO contract", () => {
    expect(modelSatisfiesIOContract({
      inputs: [
        { kind: "text", minItems: 1, maxItems: 1, required: true },
        { kind: "image", minItems: 0, maxItems: 14 }
      ],
      outputs: [{ kind: "image", minItems: 1, maxItems: 4 }]
    }, {
      inputs: [
        { kind: "text", minItems: 1, maxItems: 1, required: true },
        { kind: "image", minItems: 1, maxItems: 1, required: true }
      ]
    })).toBe(true);
  });

  it("derives an effective IO contract from legacy inputTypes and outputTypes", () => {
    expect(getModelIOContract({
      id: "legacy-vision",
      providerId: "mock",
      title: "Legacy Vision",
      capabilities: ["image.generate"],
      inputTypes: ["text", "image"],
      outputTypes: ["image"]
    })).toEqual({
      inputs: [
        { kind: "text", minItems: 0, maxItems: 1 },
        { kind: "image", minItems: 0, maxItems: 1 }
      ],
      outputs: [{ kind: "image", minItems: 0, maxItems: 1 }]
    });
  });

  it("does not match required image input to a text-only model contract", () => {
    expect(modelSatisfiesIOContract({ inputs: [{ kind: "text", maxItems: 1 }] }, { inputs: [{ kind: "image", maxItems: 1 }] })).toBe(false);
  });

  it("rejects required maxItems above the model contract", () => {
    expect(modelSatisfiesIOContract({ inputs: [{ kind: "image", maxItems: 1 }] }, { inputs: [{ kind: "image", maxItems: 14 }] })).toBe(false);
  });

  it("keeps old resolver behavior when requiredIOContract is not provided", async () => {
    const gateway = new ModelGateway({ models: [...models], adapters: [mockAdapter()], connections: [{ providerId: "mock", enabled: true, credentialRef: "provider.mock.default" }] });
    await expect(gateway.invoke({ capability: "text.generate", input: { prompt: "hi" } })).resolves.toMatchObject({ modelId: "fast-text" });
  });

  it("does not reject unknown model maxItems too aggressively", () => {
    expect(modelSatisfiesIOContract({ inputs: [{ kind: "image" }] }, { inputs: [{ kind: "image", maxItems: 14 }] })).toBe(true);
  });

  it("filters available routes by required IO contract when provided", () => {
    const gateway = new ModelGateway({
      models: [
        { id: "text-only", providerId: "mock", title: "Text Only", capabilities: ["text.generate"], ioContract: { inputs: [{ kind: "text", maxItems: 1 }] } },
        { id: "vision", providerId: "mock", title: "Vision", capabilities: ["text.generate"], ioContract: { inputs: [{ kind: "text", maxItems: 1 }, { kind: "image", maxItems: 14 }] } }
      ],
      adapters: [mockAdapter()],
      connections: [{ providerId: "mock", enabled: true, credentialRef: "provider.mock.default" }]
    });
    expect(gateway.quoteAvailableRoutes({
      capability: "text.generate",
      input: { prompt: "describe" },
      requiredIOContract: { inputs: [{ kind: "image", maxItems: 2 }] }
    }).map((quote) => quote.providerModel)).toEqual(["vision"]);
  });
});

function mockAdapter(invoke?: ProviderAdapter["invoke"]): ProviderAdapter {
  return {
    id: "mock",
    title: "Mock",
    capabilities: ["text.generate", "image.generate"],
    pricingResolver: {
      estimate: (input) => estimateCatalogPricingQuote(input, { image: 0.02 }, "mock_catalog")
    },
    invoke: invoke ?? (async (request) => ({
      modelId: request.model.id,
      providerId: request.model.providerId,
      capability: request.capability,
      output: { ok: true }
    }))
  };
}
