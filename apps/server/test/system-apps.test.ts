import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { systemAppCatalog } from "../src/routes/system";

describe("system app launcher", () => {
  it("describes every local product from one server-owned catalog", () => {
    expect(systemAppCatalog.map((app) => app.id)).toEqual([
      "living-canvas", "boojum", "brandeshmyg", "h3", "persona", "yue2"
    ]);
    expect(systemAppCatalog.every((app) => app.url.startsWith("http://127.0.0.1:"))).toBe(true);
  });

  it("serves launcher cards without hardcoded model providers", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/system/apps" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.apps.map((entry: { id: string }) => entry.id)).toEqual(systemAppCatalog.map((entry) => entry.id));
      expect(JSON.stringify(body)).not.toMatch(/openrouter|polza|kie|google/i);
    } finally {
      await app.close();
    }
  });
});
