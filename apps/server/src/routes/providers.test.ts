import { describe, expect, it } from "vitest";
import { buildServer } from "../app";

describe("model gateway quote route", () => {
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
});
