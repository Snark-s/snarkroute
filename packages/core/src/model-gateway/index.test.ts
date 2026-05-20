import { describe, expect, it, vi } from "vitest";
import { ModelGateway, ModelRegistry, type ProviderAdapter } from "./index";

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
});

function mockAdapter(invoke?: ProviderAdapter["invoke"]): ProviderAdapter {
  return {
    id: "mock",
    title: "Mock",
    capabilities: ["text.generate", "image.generate"],
    invoke: invoke ?? (async (request) => ({
      modelId: request.model.id,
      providerId: request.model.providerId,
      capability: request.capability,
      output: { ok: true }
    }))
  };
}
