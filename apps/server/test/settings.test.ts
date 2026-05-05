import { describe, expect, it } from "vitest";

describe("settings API", () => {
  it("returns API token statuses without token values", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousToken = process.env.REPLICATE_API_TOKEN;
    const previousGeminiToken = process.env.GEMINI_API_KEY;
    process.env.REPLICATE_API_TOKEN = "test-secret-token";
    process.env.GEMINI_API_KEY = "test-gemini-secret-key";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ replicate: { configured: true }, gemini: { configured: true } });
      expect(response.body).not.toContain("test-secret-token");
      expect(response.body).not.toContain("test-gemini-secret-key");
    } finally {
      await app.close();
      if (previousToken === undefined) delete process.env.REPLICATE_API_TOKEN;
      else process.env.REPLICATE_API_TOKEN = previousToken;
      if (previousGeminiToken === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiToken;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });
});
