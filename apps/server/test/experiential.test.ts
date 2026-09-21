import { afterEach, describe, expect, it, vi } from "vitest";
import { createExperientialClient, createExperientialTextNodeRunner } from "../src/providers/experiential";
import { assembleModelCatalogV1, modelOptionsForNodeV1 } from "../src/services/model-catalog-v1";
import { createRemoteTextNodeRunner } from "../src/execution/model-gateway-runners";
import { createModelResolver } from "@snarkroute/openrouter";
import Fastify from "fastify";
import { registerSettingsRoutes } from "../src/routes/settings";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("Experiential Labs", () => {
  it("lists authorized model slugs with Bearer authentication", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "qwen3.8-27b" }] })));
    const models = await createExperientialClient({ apiKey: "test-key", fetchImpl }).getModels();
    expect(models).toEqual([{ id: "qwen3.8-27b" }]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.experientiallabs.ai/v1/models");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer test-key");
  });
  it("keeps provider errors free of echoed secrets", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("test-key", { status: 401 }));
    await expect(createExperientialClient({ apiKey: "test-key", fetchImpl }).getModels()).rejects.toThrow("Experiential Labs request failed (401)");
  });
  it("runs text and preserves usage and provider identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })));
    const runner = createExperientialTextNodeRunner({ apiKey: "test-key", fetchImpl });
    const result = await runner({ node: { id: "n", type: "ai.text" }, params: { model: "qwen3.8-27b", prompt: "Hi" }, inputs: {}, context: {} } as Parameters<typeof runner>[0]);
    expect(result.output).toMatchObject({ text: "Hello", provider: "experiential", actualUsage: { prompt_tokens: 3 } });
    expect(result.provenance).toMatchObject({ provider: "experiential", model: "qwen3.8-27b" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ model: "qwen3.8-27b", messages: [{ role: "user", content: "Hi" }], stream: false });
  });
  it("exposes an executable text route in the unified catalog", () => {
    const models = assembleModelCatalogV1({ experientialModels: [{ id: "qwen3.8-27b" }] });
    expect(modelOptionsForNodeV1("ai.text", models)).toEqual(expect.arrayContaining([expect.objectContaining({ executionProvider: "experiential", providerModelId: "qwen3.8-27b" })]));
  });
  it("routes ai.text to Experiential without falling through to OpenRouter", async () => {
    vi.stubEnv("EXPLABS_API_KEY", "test-key");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "Routed" } }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const runner = createRemoteTextNodeRunner(createModelResolver([]));
    const result = await runner({ node: { id: "n", type: "ai.text" }, params: { executionProvider: "experiential", providerModelId: "qwen3.8-27b", model: "canonical-id", prompt: "Hi" }, inputs: {}, context: {} } as Parameters<typeof runner>[0]);
    expect(result.provenance).toMatchObject({ provider: "experiential", model: "qwen3.8-27b" });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.experientiallabs.ai/v1/chat/completions");
  });
  it("rejects missing keys before making a network request", async () => {
    vi.stubEnv("EXPLABS_API_KEY", "");
    const fetchImpl = vi.fn();
    await expect(createExperientialClient({ fetchImpl }).getModels()).rejects.toThrow("EXPLABS_API_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects invalid settings and never returns the full saved key", async () => {
    const key = `xpl_${"a".repeat(40)}`;
    vi.stubEnv("EXPLABS_API_KEY", key);
    const app = Fastify();
    await registerSettingsRoutes(app);
    try {
      const invalid = await app.inject({ method: "POST", url: "/api/settings/experiential-token", payload: { experientialApiKey: "bad\nkey" } });
      expect(invalid.statusCode).toBe(400);
      const settings = await app.inject({ method: "GET", url: "/api/settings" });
      expect(settings.json().experiential.configured).toBe(true);
      expect(settings.body).not.toContain(key);
    } finally { await app.close(); }
  });
});
