import { describe, expect, it } from "vitest";

describe("settings API", () => {
  it("returns API token statuses without token values", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousToken = process.env.REPLICATE_API_TOKEN;
    const previousGeminiToken = process.env.GEMINI_API_KEY;
    const previousOpenRouterToken = process.env.OPENROUTER_API_KEY;
    const previousSeedanceBackend = process.env.SEEDANCE_PROVIDER_BACKEND;
    const previousArkToken = process.env.ARK_API_KEY;
    const previousSeedanceToken = process.env.SEEDANCE_API_KEY;
    process.env.REPLICATE_API_TOKEN = "test-secret-token";
    process.env.GEMINI_API_KEY = "test-gemini-secret-key";
    process.env.OPENROUTER_API_KEY = "sk-or-test-secret-key";
    process.env.SEEDANCE_PROVIDER_BACKEND = "byteplus-modelark";
    process.env.ARK_API_KEY = "ark-test-secret-b740";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ replicate: { configured: true }, gemini: { configured: true }, openrouter: { configured: true }, seedance: { configured: true, backend: "byteplus-modelark", apiKeyEnvKey: "ARK_API_KEY" } });
      expect(response.body).not.toContain("test-secret-token");
      expect(response.body).not.toContain("test-gemini-secret-key");
      expect(response.body).not.toContain("sk-or-test-secret-key");
      expect(response.body).not.toContain("ark-test-secret-b740");
      expect(response.json().openrouter.maskedApiKey).toContain("****");
      expect(response.json().seedance.maskedApiKey).toContain("****");
    } finally {
      await app.close();
      if (previousToken === undefined) delete process.env.REPLICATE_API_TOKEN;
      else process.env.REPLICATE_API_TOKEN = previousToken;
      if (previousGeminiToken === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiToken;
      if (previousOpenRouterToken === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterToken;
      if (previousSeedanceBackend === undefined) delete process.env.SEEDANCE_PROVIDER_BACKEND;
      else process.env.SEEDANCE_PROVIDER_BACKEND = previousSeedanceBackend;
      if (previousArkToken === undefined) delete process.env.ARK_API_KEY;
      else process.env.ARK_API_KEY = previousArkToken;
      if (previousSeedanceToken === undefined) delete process.env.SEEDANCE_API_KEY;
      else process.env.SEEDANCE_API_KEY = previousSeedanceToken;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("does not mark Seedance configured when only a key is present", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousBackend = process.env.SEEDANCE_PROVIDER_BACKEND;
    const previousToken = process.env.SEEDANCE_API_KEY;
    const previousBaseUrl = process.env.SEEDANCE_API_BASE_URL;
    delete process.env.SEEDANCE_PROVIDER_BACKEND;
    process.env.SEEDANCE_API_KEY = "seed-secret-key";
    delete process.env.SEEDANCE_API_BASE_URL;
    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json().seedance).toMatchObject({ configured: false, statusText: "key saved, provider/base URL not verified" });
    } finally {
      await app.close();
      if (previousBackend === undefined) delete process.env.SEEDANCE_PROVIDER_BACKEND;
      else process.env.SEEDANCE_PROVIDER_BACKEND = previousBackend;
      if (previousToken === undefined) delete process.env.SEEDANCE_API_KEY;
      else process.env.SEEDANCE_API_KEY = previousToken;
      if (previousBaseUrl === undefined) delete process.env.SEEDANCE_API_BASE_URL;
      else process.env.SEEDANCE_API_BASE_URL = previousBaseUrl;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("returns provider links including OpenRouter", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers/links" });
      expect(response.statusCode).toBe(200);
      expect(response.json().openrouter.apiKeysUrl).toBe("https://openrouter.ai/settings/keys");
      expect(response.json().seedance.byteplusApiKeysUrl).toBe("https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey");
    } finally {
      await app.close();
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });
});
