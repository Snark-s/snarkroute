import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../app";

describe("model gateway quote route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a selected quote without requiring provider API keys", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/model-gateway/quote",
      payload: {
        nodeType: "gemini.nano-banana-2",
        params: { n: 2, apiKey: "sk-hidden" }
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.selected).toMatchObject({ provider: "gemini", providerModel: "gemini-3.1-flash-image-preview", estimatedCost: null, confidence: "low", pricingConfidence: "low" });
    expect(response.body).not.toContain("sk-hidden");
    await app.close();
  });

  it("refreshes OpenRouter pricing catalog without returning secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "openai/gpt-5.2", pricing: { request: "0.01" } }]
    }), { status: 200 })));
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/model-pricing/refresh",
      payload: { provider: "openrouter" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ refreshed: ["openrouter"], failed: [] });
    expect(response.body).not.toMatch(/apiKey|token|secret|password/i);
    await app.close();
  });
});

describe("Polza model catalog endpoint semantics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the full live image catalog from the provider endpoint without executable filtering", async () => {
    stubPolzaImageCatalog();
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers/polza/models?type=image" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.modelCount).toBe(4);
      expect(body.models.map((model: { id: string }) => model.id)).toEqual([
        "openai/gpt-5.4-image-2",
        "qwen/image-2",
        "topaz/image-upscale",
        "vendor/unlisted-image"
      ]);
    } finally {
      await app.close();
    }
  });

  it("keeps node-compatible Polza image options separate from the raw provider endpoint", async () => {
    stubPolzaImageCatalog();
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/for-node/polza.image.generate" });
      const body = response.json();
      const ids = body.models.map((model: { storedModelId: string }) => model.storedModelId);

      expect(response.statusCode).toBe(200);
      expect(ids).toContain("qwen/image-2");
      expect(ids).toContain("vendor/unlisted-image");
      expect(ids).not.toContain("topaz/image-upscale");
      expect(ids).not.toContain("openai/gpt-5.2-chat");
      expect(ids.every((id: string) => !id.startsWith("polza:"))).toBe(true);
      expect(body.models.every((model: { storedModelId: string; providerModelId: string }) =>
        !model.storedModelId.startsWith("polza:") && !model.providerModelId.startsWith("polza:")
      )).toBe(true);
    } finally {
      await app.close();
    }
  });
});

function stubPolzaImageCatalog() {
  vi.stubEnv("POLZA_AI_API_KEY", "test-polza-key");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/models?type=image")) {
      return new Response(JSON.stringify({
        data: [
          polzaModel("openai/gpt-5.4-image-2", "image", ["text"], ["image"]),
          polzaModel("qwen/image-2", "image", ["text"], ["image"]),
          polzaModel("topaz/image-upscale", "image", ["image"], ["image"]),
          polzaModel("vendor/unlisted-image", "image", ["text"], ["image"])
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/models?type=chat")) {
      return new Response(JSON.stringify({
        data: [polzaModel("openai/gpt-5.2-chat", "chat", ["text", "image"], ["text"])]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function polzaModel(id: string, type: string, input_modalities: string[], output_modalities: string[]) {
  return {
    id,
    name: id,
    type,
    architecture: { input_modalities, output_modalities },
    supported_parameters: []
  };
}
