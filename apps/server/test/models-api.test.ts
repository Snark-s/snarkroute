import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app";

describe("model catalog API", () => {
  it("returns legacy model shape as a V1 compatibility adapter", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.models.length).toBe(body.modelCount);
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
        catalogStatus: expect.stringMatching(/^(known|unknown)$/)
      });
      expect(body.models[0].outputTypes).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("serves /api/models from the single explicit V1-backed legacy implementation", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models?media=image" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
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
      const openRouterOptionIds = body.models
        .filter((model: { provider: string }) => model.provider === "openrouter")
        .map((model: { storedModelId: string }) => model.storedModelId);

      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.nodeType).toBe("ai.image.generate");
      expect(body.modelCount).toBeGreaterThan(1);
      expect(optionIds).toContain("image.nano-banana");
      expect(openRouterOptionIds.length).toBeGreaterThan(1);
      expect(openRouterOptionIds).toContain("openai/gpt-image-1");
      expect(optionIds).not.toContain("openrouter/auto");
      expect(body.models.every((model: { storedModelId: string; providerModelId: string }) =>
        model.storedModelId === model.providerModelId
      )).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns one executable generation catalog for CEP consumers", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/executable-generation" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.nodeTypes).toEqual(expect.arrayContaining(["ai.image.generate", "polza.image.generate", "polza.video.generate"]));
      expect(body.models.some((model: { outputTypes: string[] }) => model.outputTypes.includes("image"))).toBe(true);
      expect(body.models.some((model: { outputTypes: string[] }) => model.outputTypes.includes("video"))).toBe(true);
      expect(body.models.every((model: { nodeType: string; availability: { status: string } }) => model.nodeType && model.availability.status === "available")).toBe(true);
      expect(body.models.every((model: { inputContract?: object }) => model.inputContract)).toBe(true);
      expect(body.models.filter((model: { outputTypes: string[] }) => model.outputTypes.includes("video")).some((model: { inputContract: { inputs?: Array<{ kind: string }> } }) => model.inputContract.inputs?.some((input) => input.kind === "image"))).toBe(true);
    } finally { await app.close(); }
  });

  it("keeps image and video output models out of text node selectors", async () => {
    const app = buildServer();
    try {
      for (const nodeType of ["ai.text", "polza.text"]) {
        const response = await app.inject({ method: "GET", url: `/api/models/for-node/${nodeType}` });
        const body = response.json();
        const optionIds = body.models.map((model: { providerModelId: string }) => model.providerModelId);

        expect(response.statusCode).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.modelCount).toBeGreaterThan(0);
        expect(body.models.every((model: { outputTypes: string[]; roles: string[] }) =>
          model.outputTypes.includes("text")
          && !model.outputTypes.includes("image")
          && !model.outputTypes.includes("video")
          && !model.roles.includes("upscaler")
        )).toBe(true);
        expect(optionIds).not.toEqual(expect.arrayContaining([
          "qwen/image",
          "qwen/image-2",
          "google/gemini-3.1-flash-image-preview",
          "bytedance/seedream-5-lite",
          "bytedance/seedance-2",
          "topaz/video-upscale"
        ]));
      }
    } finally {
      await app.close();
    }
  });

  it("keeps text-only and upscaler models out of image node selectors", async () => {
    const app = buildServer();
    try {
      for (const nodeType of ["ai.image.generate", "polza.image.generate"]) {
        const response = await app.inject({ method: "GET", url: `/api/models/for-node/${nodeType}` });
        const body = response.json();
        const optionIds = body.models.map((model: { providerModelId: string }) => model.providerModelId);

        expect(response.statusCode).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.modelCount).toBeGreaterThan(0);
        expect(body.models.every((model: { outputTypes: string[]; roles: string[] }) =>
          model.outputTypes.includes("image")
          && !model.roles.includes("upscaler")
        )).toBe(true);
        expect(optionIds).not.toEqual(expect.arrayContaining([
          "openai/gpt-5.1",
          "openai/gpt-5.2",
          "anthropic/claude-opus-4.7-fast",
          "topaz/image-upscale",
          "topaz/video-upscale"
        ]));
      }
    } finally {
      await app.close();
    }
  });

  it("keeps video upscalers out of normal video node selectors", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/for-node/polza.video.generate" });
      const body = response.json();
      const optionIds = body.models.map((model: { providerModelId: string }) => model.providerModelId);

      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.modelCount).toBeGreaterThan(0);
      expect(body.models.every((model: { outputTypes: string[]; roles: string[] }) =>
        model.outputTypes.includes("video")
        && !model.roles.includes("upscaler")
      )).toBe(true);
      expect(optionIds).not.toContain("topaz/video-upscale");
    } finally {
      await app.close();
    }
  });

  it("filters video models through the shared supplied-input contract", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/for-node/polza.video.generate?image=1&video=0&audio=0" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.suppliedInputs).toEqual({ image: 1, video: 0, audio: 0 });
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.every((model: { runnableWithSuppliedInputs: boolean; maximumImageInputs: number }) => model.runnableWithSuppliedInputs && model.maximumImageInputs >= 1)).toBe(true);
      expect(body.models.map((model: { providerModelId: string }) => model.providerModelId)).toContain("wan/2.6");
    } finally {
      await app.close();
    }
  });

  it("exposes safe model filtering diagnostics for the generic Polza video runner", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/for-node/polza.video.generate/debug?image=1&video=0&audio=0" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.nodeType).toBe("polza.video.generate");
      expect(body.counts).toMatchObject({ allModels: expect.any(Number), polzaVideo: expect.any(Number), polzaImageToVideo: expect.any(Number), final: expect.any(Number) });
      expect(body.included).toEqual(expect.any(Array));
      expect(body.excluded).toEqual(expect.any(Array));
      expect(body.included[0]).toMatchObject({ inputContract: expect.any(Object), suppliedImageInputs: 1, runnableWithSuppliedInputs: true, executableByRunner: true });
      if (body.included[0]) expect(body.included[0]).not.toHaveProperty("metadata");
      if (body.excluded[0]) expect(body.excluded[0]).not.toHaveProperty("metadata");
    } finally {
      await app.close();
    }
  });

  it("returns iconPath and parameters array for every legacy-compatible model", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.models.length).toBeGreaterThan(0);
      for (const model of body.models as Array<{ catalogStatus: string; iconPath: string; parameters: unknown[] }>) {
        expect(["known", "unknown"]).toContain(model.catalogStatus);
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
