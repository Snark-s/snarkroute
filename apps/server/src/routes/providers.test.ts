import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../app";

describe("model gateway quote route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(body.selected).toMatchObject({ provider: "gemini", providerModel: "gemini-3.1-flash-image-preview", estimatedCost: null, confidence: "unknown" });
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
