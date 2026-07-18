import { describe, expect, it } from "vitest";

describe("Image Generation route validation", () => {
  it("runs in cloud mode without DATABASE_URL using local bookkeeping", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousAppMode = process.env.APP_MODE;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.APP_MODE = "cloud";
    delete process.env.DATABASE_URL;
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/routes/run",
        payload: {
          routeVersion: "0.1",
          route: { id: "cloud-no-db-local-run", title: "Cloud No DB Local Run", author: {}, tags: ["demo-safe"] },
          nodes: [{ id: "text", type: "input.text", params: { value: "hello" } }],
          edges: []
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("DATABASE_URL is required");
      expect(response.json().status).toBe("succeeded");
    } finally {
      await app.close();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousAppMode === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = previousAppMode;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("returns a clear error when OpenRouter is selected but not configured", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousAppMode = process.env.APP_MODE;
    const previousOpenRouterToken = process.env.OPENROUTER_API_KEY;
    process.env.APP_MODE = "local";
    process.env.OPENROUTER_API_KEY = "";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/routes/run",
        payload: imageRoute({ model: "openai/gpt-5.4-image-2", providerMode: "openrouter" })
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("OpenRouter is selected, but OpenRouter is not configured.");
    } finally {
      await app.close();
      if (previousOpenRouterToken === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterToken;
      if (previousAppMode === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = previousAppMode;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("returns a clear error when Direct API is selected but credentials are missing", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousAppMode = process.env.APP_MODE;
    const previousGeminiToken = process.env.GEMINI_API_KEY;
    process.env.APP_MODE = "local";
    process.env.GEMINI_API_KEY = "";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/routes/run",
        payload: imageRoute({ model: "image.nano-banana", providerMode: "direct" })
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Direct API is selected, but direct provider credentials are missing.");
    } finally {
      await app.close();
      if (previousGeminiToken === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiToken;
      if (previousAppMode === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = previousAppMode;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });
});

function imageRoute(params: Record<string, unknown>) {
  return {
    routeVersion: "0.1",
    route: { id: "image-routing", title: "Image Routing", author: {} },
    nodes: [
      { id: "image", type: "ai.image.generate", params: { prompt: "draw", ...params } }
    ],
    edges: []
  };
}
