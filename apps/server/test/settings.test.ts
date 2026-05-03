import { describe, expect, it } from "vitest";

describe("settings API", () => {
  it("returns Replicate token status without token value", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousToken = process.env.REPLICATE_API_TOKEN;
    process.env.REPLICATE_API_TOKEN = "test-secret-token";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ replicate: { configured: true } });
      expect(response.body).not.toContain("test-secret-token");
    } finally {
      await app.close();
      if (previousToken === undefined) delete process.env.REPLICATE_API_TOKEN;
      else process.env.REPLICATE_API_TOKEN = previousToken;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });
});
