import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  buildChatRequestBody,
  buildImageRequestBody,
  createOpenRouterImageNodeRunner,
  createModelResolver,
  createOpenRouterClient,
  createOpenRouterTextNodeRunner,
  parseOpenRouterModelCatalog,
  refreshOpenRouterModelCatalog,
  resolveModelProvider
} from "../src/index";

describe("OpenRouter adapter", () => {
  it("builds a chat completions request with supported parameters only", () => {
    expect(buildChatRequestBody("openai/gpt-5.2", [{ role: "user", content: "hi" }], { temperature: 0.2, max_tokens: 42, presence_penalty: 1 })).toEqual({
      model: "openai/gpt-5.2",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      max_tokens: 42
    });
  });

  it("builds an image request with the selected slug, not the display label", () => {
    expect(buildImageRequestBody("openai/gpt-5.4-image-2", "draw", { aspectRatio: "16:9", imageSize: "2K" })).toMatchObject({
      model: "openai/gpt-5.4-image-2",
      messages: [{ role: "user", content: "draw" }],
      modalities: ["image", "text"],
      aspect_ratio: "16:9",
      size: "2K"
    });
  });

  it("attaches input images to image requests", () => {
    expect(buildImageRequestBody("openai/gpt-5.4-image-2", "edit", {}, ["data:image/png;base64,aaa"])).toMatchObject({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "edit" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } }
        ]
      }]
    });
  });

  it("returns a clear error when the API key is missing", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await expect(createOpenRouterClient({ fetchImpl: vi.fn() as unknown as typeof fetch }).testConnection()).rejects.toThrow("OpenRouter API key is missing.");
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });

  it("tests connection with a mocked successful response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.2" }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(createOpenRouterClient({ apiKey: "sk-test", fetchImpl }).testConnection()).resolves.toEqual({ ok: true, modelCount: 1 });
  });

  it("retries transient catalog network failures once", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.2" }] }), { status: 200 })) as unknown as typeof fetch;

    await expect(createOpenRouterClient({ apiKey: "sk-test", fetchImpl, retryDelayMs: 0 }).testConnection()).resolves.toEqual({ ok: true, modelCount: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses OPENROUTER_BASE_URL when no explicit base URL is provided", async () => {
    const previous = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = "https://openrouter.local/api/v1/";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    try {
      await createOpenRouterClient({ apiKey: "sk-test", fetchImpl }).testConnection();
      expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.local/api/v1/models", expect.any(Object));
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = previous;
    }
  });

  it("handles invalid API keys with a human error", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await expect(createOpenRouterClient({ apiKey: "sk-bad", fetchImpl }).testConnection()).rejects.toThrow("OpenRouter API key seems invalid.");
  });

  it("refreshes and saves the model catalog cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snarkroute-openrouter-"));
    try {
      const cachePath = join(dir, "openrouter-models.json");
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.2", name: "GPT" }] }), { status: 200 })) as unknown as typeof fetch;
      const cache = await refreshOpenRouterModelCatalog({ fetchImpl, cachePath });
      expect(cache.models).toHaveLength(1);
      expect(await readFile(cachePath, "utf8")).toContain("openai/gpt-5.2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses catalogs defensively when optional fields are missing", () => {
    expect(parseOpenRouterModelCatalog({ data: [{ id: "x/y" }, { name: "missing id" }] })).toEqual([
      { id: "x/y", architecture: { input_modalities: undefined, output_modalities: undefined, modality: undefined }, context_length: undefined, description: undefined, name: undefined, pricing: undefined, supported_parameters: undefined, top_provider: undefined }
    ]);
  });

  it("returns unknown cost instead of a fake number when pricing is absent", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch;
    const runner = createOpenRouterTextNodeRunner({ apiKey: "sk-test", fetchImpl });
    const result = await runner({
      node: { id: "n1", type: "ai.text" },
      params: { model: "openai/gpt-5.2", prompt: "hi" },
      inputs: {},
      context: { runId: "r1", route: { routeVersion: "0.1", route: { id: "r", title: "R", author: {} }, nodes: [], edges: [] }, outputDirectory: "", nodeOutputs: {}, log: () => undefined }
    });
    expect((result.output as Record<string, unknown>).estimatedCost).toBeNull();
    expect((result.output as Record<string, unknown>).pricingSource).toBe("unknown");
  });

  it("runs image-capable OpenRouter slugs without a hardcoded local mapping", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-openrouter-image-"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,aaa" } }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const runner = createOpenRouterImageNodeRunner({
      apiKey: "sk-test",
      fetchImpl,
      modelResolver: createModelResolver([])
    });
    const result = await runner({
      node: { id: "n1", type: "ai.image.generate" },
      params: { model: "openai/gpt-5.4-image-2", providerMode: "openrouter", prompt: "draw" },
      inputs: {},
      context: { runId: "r1", route: { routeVersion: "0.1", route: { id: "r", title: "R", author: {} }, nodes: [], edges: [] }, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });
    expect((result.output as Record<string, unknown>).requestModelSlug).toBe("openai/gpt-5.4-image-2");
    expect((result.output as Record<string, unknown>).selectedModelLabel).not.toBe("OpenAI: GPT-5.4 Image 2");
    const image = (result.output as { image: { localPath: string } }).image;
    expect(await readFile(image.localPath)).toEqual(Buffer.from("aaa", "base64"));
  });
});

describe("resolveModelProvider", () => {
  const mappings = [
    { id: "text.default", task: "text", openrouterModel: "openai/gpt-5.2", status: "supported" as const },
    { id: "image.nano-banana", task: "image", label: "Nano Banana", openrouterModel: null, directProvider: "gemini", directModel: "gemini-3.1-flash-image-preview", status: "unknown" as const }
  ];

  it("auto uses OpenRouter when mapping is supported", () => {
    expect(createModelResolver(mappings)({ task: "text", modelId: "text.default", providerMode: "auto" }).provider).toBe("openrouter");
  });

  it("auto uses direct only when an explicit direct mapping exists", () => {
    expect(resolveModelProvider({ task: "image", modelId: "image.nano-banana", providerMode: "auto", mappings })).toMatchObject({ provider: "direct", directProvider: "gemini", fallbackUsed: false });
  });

  it("providerMode=openrouter fails clearly when no OpenRouter model exists", () => {
    expect(() => resolveModelProvider({ task: "image", modelId: "image.nano-banana", providerMode: "openrouter", mappings })).toThrow("This model is listed in the UI but has no executable image route.");
  });

  it("direct route requires an explicit direct mapping", () => {
    expect(() => resolveModelProvider({ task: "image", modelId: "openai/gpt-5.4-image-2", providerMode: "direct", mappings })).toThrow("Direct API route requires a provider mapping for openai/gpt-5.4-image-2, but none was found.");
  });

  it("auto does not silently switch unknown OpenRouter slugs to Direct", () => {
    expect(() => resolveModelProvider({ task: "image", modelId: "openai/gpt-5.4-image-2", providerMode: "auto", mappings })).toThrow("Auto route cannot resolve this model because image support is unknown. Choose OpenRouter or Direct API explicitly.");
  });

  it("auto resolves a catalog-verified OpenRouter image slug to OpenRouter", () => {
    expect(resolveModelProvider({
      task: "image",
      modelId: "openai/gpt-5-image-mini",
      providerMode: "auto",
      mappings: [{
        id: "openai/gpt-5-image-mini",
        task: "image",
        label: "OpenAI: GPT-5 Image Mini",
        openrouterModel: "openai/gpt-5-image-mini",
        supportsImageGeneration: "supported",
        routeSupport: { openrouter: "supported", direct: "unknown" },
        status: "supported"
      }]
    })).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-5-image-mini",
      selectedConnectionRoute: "auto",
      supportsImageGeneration: "supported"
    });
  });

  it("does not expose the old mapped-yet error", () => {
    expect(() => resolveModelProvider({ task: "image", modelId: "missing-model", providerMode: "openrouter", mappings })).toThrow("This model is not available for image generation.");
    try {
      resolveModelProvider({ task: "image", modelId: "missing-model", providerMode: "openrouter", mappings });
    } catch (error) {
      expect(String(error)).not.toContain(["mapped", "yet"].join(" "));
    }
  });
});
