import { describe, expect, it } from "vitest";
import { listKnownModels } from "@snarkroute/model-catalog";
import { buildServer } from "../src/app";

describe("model catalog API", () => {
  it("returns known models", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.modelCount).toBe(listKnownModels().length);
      expect(body.models.length).toBe(body.modelCount);
      expect(body.models.every((model: { catalogStatus: string }) => model.catalogStatus === "known")).toBe(true);
      expect(body.models[0]).toMatchObject({
        id: expect.any(String),
        provider: expect.any(String),
        providerModelId: expect.any(String),
        displayName: expect.any(String),
        outputType: expect.any(String),
        inputTypes: expect.any(Array),
        iconKey: expect.any(String),
        iconPath: expect.any(String),
        parameters: expect.any(Array),
        catalogStatus: "known"
      });
    } finally {
      await app.close();
    }
  });

  it("serves /api/models from the single explicit legacy implementation", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models?media=image" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.modelCount).toBe(listKnownModels().length);
      expect(body.models.length).toBe(body.modelCount);
      expect(body.models.every((model: { outputType: string; outputTypes?: unknown }) =>
        typeof model.outputType === "string" && model.outputTypes === undefined
      )).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns the Model Catalog V1 shape from /api/models/v1", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/v1" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.models.length).toBe(body.modelCount);
      expect(body.models[0]).toMatchObject({
        id: expect.any(String),
        provider: expect.any(String),
        providerModelId: expect.any(String),
        outputTypes: expect.any(Array),
        inputTypes: expect.any(Array),
        capabilities: expect.any(Array),
        roles: expect.any(Array)
      });
    } finally {
      await app.close();
    }
  });

  it("filters image models by outputType", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models?outputType=image" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.models.length).toBe(body.modelCount);
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.every((model: { outputType: string }) => model.outputType === "image")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("filters text models by outputType", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models?outputType=text" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.models.length).toBe(body.modelCount);
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.every((model: { outputType: string }) => model.outputType === "text")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("filters models by provider", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models?provider=polza" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.models.length).toBe(body.modelCount);
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.every((model: { provider: string }) => model.provider === "polza")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("filters models by capability", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models?capability=image.generate" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.models.length).toBe(body.modelCount);
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.every((model: { capabilities?: string[] }) => model.capabilities?.includes("image.generate"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns provider-native ai.image.generate options with the direct fallback", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/for-node/ai.image.generate" });
      const body = response.json();
      const optionIds = body.models.map((model: { storedModelId: string }) => model.storedModelId);

      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.nodeType).toBe("ai.image.generate");
      expect(optionIds).toContain("image.nano-banana");
      expect(optionIds).not.toContain("openrouter/auto");
      expect(body.models.every((model: { storedModelId: string; providerModelId: string }) =>
        model.storedModelId === model.providerModelId
      )).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns iconPath and parameters array for every known model", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.models.length).toBeGreaterThan(0);
      for (const model of body.models as Array<{ catalogStatus: string; iconPath: string; parameters: unknown[] }>) {
        expect(model.catalogStatus).toBe("known");
        expect(model.iconPath).toContain("/api/model-icons/");
        expect(Array.isArray(model.parameters)).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects model icon path traversal", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/model-icons/../package.json" });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for missing model icons", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/model-icons/missing.svg" });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
