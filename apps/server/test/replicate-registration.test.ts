import { describe, expect, it } from "vitest";

describe("Replicate runner registration", () => {
  it("registers clarity runner even when token is missing", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousToken = process.env.REPLICATE_API_TOKEN;
    const { buildServer } = await import("../src/index");
    process.env.REPLICATE_API_TOKEN = "";
    const app = buildServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/routes/run",
        payload: {
          routeVersion: "0.1",
          route: { id: "clarity-no-token", title: "Clarity No Token", author: {} },
          nodes: [
            { id: "upscale", type: "replicate.clarity-upscaler", params: { image: "https://example.com/in.png" } }
          ],
          edges: []
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("REPLICATE_API_TOKEN is not configured.\\nOpen Settings \u2192 Secrets \u2192 Replicate and paste your token.");
      expect(response.body).not.toContain("No runner registered");
    } finally {
      await app.close();
      if (previousToken === undefined) delete process.env.REPLICATE_API_TOKEN;
      else process.env.REPLICATE_API_TOKEN = previousToken;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });
});
