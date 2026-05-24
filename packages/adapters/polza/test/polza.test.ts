import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildImageRequestBody, buildMediaImageRequestBody, createPolzaImageNodeRunner, createPolzaTextNodeRunner, estimatePolzaPricingQuote, estimatePolzaPricingQuoteFromCatalog, polzaPricingCatalogFromModels, readPolzaPricingCatalogCache, refreshPolzaPricingCatalog } from "../src/index";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init
  });
}

describe("Polza adapter", () => {
  it("builds OpenAI-compatible image generation payload", () => {
    expect(buildImageRequestBody("openai/gpt-5-image-mini", "draw", { aspectRatio: "16:9", imageSize: "high", outputFormat: "png" })).toMatchObject({
      model: "openai/gpt-5-image-mini",
      prompt: "draw",
      size: "1792x1024",
      quality: "high",
      response_format: "b64_json",
      output_format: "png"
    });
  });

  it("maps auto image size from aspect ratio", () => {
    expect(buildImageRequestBody("dall-e-3", "draw", { aspectRatio: "9:16", size: "auto" })).toMatchObject({
      size: "1024x1792"
    });
  });

  it("builds native media image payload with aspect ratio", () => {
    expect(buildMediaImageRequestBody("openai/gpt-5.4-image-2", "draw", { aspectRatio: "16:9", imageSize: "2K", quality: "high", outputFormat: "png" }, [{ type: "base64", data: "data:image/png;base64,aaa" }])).toMatchObject({
      model: "openai/gpt-5.4-image-2",
      input: {
        prompt: "draw",
        images: [{ type: "base64", data: "data:image/png;base64,aaa" }],
        aspect_ratio: "16:9",
        n: 1
      },
      async: false
    });
  });

  it("catalog pricing returns a Polza image quote", () => {
    expect(estimatePolzaPricingQuote({
      provider: "polza",
      providerModel: "openai/gpt-5.4-image-2",
      capability: "image.generate",
      params: { n: 2, pricing: { image: "1.5", currency: "RUB" } },
      inputMetadata: {}
    })).toMatchObject({ estimatedCost: 3, currency: "RUB", pricingSource: "polza_catalog" });
  });

  it("missing Polza pricing returns unknown quote", () => {
    expect(estimatePolzaPricingQuote({
      provider: "polza",
      providerModel: "openai/gpt-5.4-image-2",
      capability: "image.generate",
      params: {},
      inputMetadata: {}
    })).toMatchObject({ estimatedCost: null, confidence: "unknown" });
  });

  it("refreshes Polza pricing catalog when model catalog contains pricing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-polza-pricing-"));
    const cachePath = join(directory, "polza.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "openai/gpt-4o", pricing: { prompt: "0.1", completion: "0.2", currency: "RUB" } }] }));
    const catalog = await refreshPolzaPricingCatalog({ apiKey: "pza-test", fetchImpl, cachePath, type: "chat" });
    expect(catalog.models["openai/gpt-4o"].pricing).toMatchObject({ prompt: "0.1" });
    expect(await readPolzaPricingCatalogCache(cachePath)).toMatchObject({ provider: "polza", source: "polza_models_catalog" });
  });

  it("cached Polza pricing catalog is usable by quote", () => {
    const catalog = polzaPricingCatalogFromModels([{ id: "openai/gpt-5.4-image-2", pricing: { image: 1.5, currency: "RUB" } }]);
    expect(estimatePolzaPricingQuoteFromCatalog({
      provider: "polza",
      providerModel: "openai/gpt-5.4-image-2",
      capability: "image.generate",
      params: {},
      inputMetadata: {}
    }, catalog)).toMatchObject({ estimatedCost: 1.5, currency: "RUB", pricingStatus: "fresh" });
  });

  it("does not send unsupported aspect ratio controls to GPT-5 Image Mini", () => {
    expect(buildMediaImageRequestBody("openai/gpt-5-image-mini", "draw", { aspectRatio: "16:9", imageSize: "2K", quality: "high" })).toMatchObject({
      model: "openai/gpt-5-image-mini",
      input: { prompt: "draw" }
    });
  });

  it("generates text through chat completions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hello" } }], usage: { cost: 0.1 } }));
    const runner = createPolzaTextNodeRunner({ apiKey: "pza-test", fetchImpl });

    const result = await runner({
      node: { id: "text", type: "polza.text", params: {} },
      params: { model: "openai/gpt-4o", prompt: "hi" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://polza.ai/api/v1/chat/completions", expect.any(Object));
    expect(result.output).toMatchObject({ text: "hello", provider: "polza", model: "openai/gpt-4o" });
    expect(result.providerUsage).toMatchObject({ provider: "polza", actualCost: 0.1 });
  });

  it("passes image inputs to Polza chat completions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "image described" } }] }));
    const runner = createPolzaTextNodeRunner({ apiKey: "pza-test", fetchImpl });

    await runner({
      node: { id: "text", type: "polza.text", params: {} },
      params: { model: "openai/gpt-4o", prompt: "describe" },
      inputs: { images: "data:image/png;base64,aaa" },
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } }
    ]);
  });

  it("passes multiple image inputs to Polza chat completions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "two images described" } }] }));
    const runner = createPolzaTextNodeRunner({ apiKey: "pza-test", fetchImpl });

    await runner({
      node: { id: "text", type: "polza.text", params: {} },
      params: { model: "openai/gpt-4o", prompt: "compare" },
      inputs: { images: [{ image: "data:image/png;base64,aaa" }, { image: "data:image/jpeg;base64,bbb" }] },
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "compare" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,bbb" } }
    ]);
  });

  it("Polza text runner calls Model Gateway", async () => {
    const modelGateway = {
      invoke: vi.fn(async () => ({
        modelId: "openai/gpt-4o",
        providerId: "polza",
        capability: "text.generate",
        output: {
          text: "gateway hello",
          output: { choices: [{ message: { content: "gateway hello" } }], usage: { cost: 0.2 } },
          model: "openai/gpt-4o"
        },
        raw: { choices: [{ message: { content: "gateway hello" } }], usage: { cost: 0.2 } }
      }))
    };
    const runner = createPolzaTextNodeRunner({ modelGateway });
    const result = await runner({
      node: { id: "text", type: "polza.text", params: {} },
      params: { model: "openai/gpt-4o", prompt: "hi" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    expect(modelGateway.invoke).toHaveBeenCalledWith(expect.objectContaining({
      capability: "text.generate",
      modelRef: "model://polza/openai/gpt-4o",
      input: expect.objectContaining({ prompt: "hi" }),
      metadata: { nodeId: "text", nodeType: "polza.text" }
    }));
    expect(result.output).toMatchObject({ text: "gateway hello", provider: "polza", model: "openai/gpt-4o" });
  });

  it("writes generated base64 image output", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-image-"));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: Buffer.from("image").toString("base64") }], usage: { cost_rub: 1.5 } }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl });

    const result = await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "openai/gpt-5-image-mini", prompt: "draw" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://polza.ai/api/v1/media", expect.any(Object));
    expect(result.output).toMatchObject({ provider: "polza", image: { mimeType: "image/png", sizeBytes: 5 } });
    expect(result.providerUsage).toMatchObject({ provider: "polza", actualCost: 1.5 });
  });

  it("passes input images to Polza media image models", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-image-input-"));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl });

    const result = await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "openai/gpt-5.4-image-2", prompt: "edit" },
      inputs: { images: [{ image: "data:image/png;base64,aaa" }] },
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://polza.ai/api/v1/media", expect.objectContaining({
      body: expect.stringContaining("\"images\":[{\"type\":\"base64\",\"data\":\"data:image/png;base64,aaa\"}]")
    }));
    expect(result.output).toMatchObject({ provider: "polza", inputImageCount: 1 });
  });

  it("Polza image runner calls Model Gateway", async () => {
    const image = {
      localPath: join(tmpdir(), "polza-gateway.png"),
      path: join(tmpdir(), "polza-gateway.png"),
      filename: "polza-gateway.png",
      mimeType: "image/png",
      sizeBytes: 5,
      sourceNodeId: "image",
      model: "openai/gpt-5-image-mini"
    };
    const modelGateway = {
      invoke: vi.fn(async () => ({
        modelId: "openai/gpt-5-image-mini",
        providerId: "polza",
        capability: "image.generate",
        output: {
          image,
          output: { data: [{ b64_json: "aaa" }], usage: { cost_rub: 1.5 } },
          request: { model: "openai/gpt-5-image-mini", input: { prompt: "draw" } },
          model: "openai/gpt-5-image-mini"
        },
        raw: { data: [{ b64_json: "aaa" }], usage: { cost_rub: 1.5 } }
      }))
    };
    const runner = createPolzaImageNodeRunner({ modelGateway });
    const result = await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "openai/gpt-5-image-mini", prompt: "draw" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    expect(modelGateway.invoke).toHaveBeenCalledWith(expect.objectContaining({
      capability: "image.generate",
      modelRef: "model://polza/openai/gpt-5-image-mini",
      input: { prompt: "draw", images: [] },
      metadata: expect.objectContaining({ nodeId: "image", nodeType: "polza.image.generate" })
    }));
    expect(result.output).toMatchObject({ provider: "polza", model: "openai/gpt-5-image-mini", image });
  });

  it("polls pending Polza media generations until image output is ready", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-poll-"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "aig_123", status: "pending", model: "google/gemini-3.1-flash-image-preview" }))
      .mockResolvedValueOnce(jsonResponse({ id: "aig_123", status: "processing" }))
      .mockResolvedValueOnce(jsonResponse({ id: "aig_123", status: "completed", data: { url: "https://cdn.polza.ai/out.png" } }))
      .mockResolvedValueOnce(new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/png" } }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl, mediaPollIntervalMs: 1 });

    const result = await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "google/gemini-3.1-flash-image-preview", prompt: "draw" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://polza.ai/api/v1/media/aig_123", expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "https://polza.ai/api/v1/media/aig_123", expect.any(Object));
    expect(result.output).toMatchObject({ provider: "polza", image: { originalUrl: "https://cdn.polza.ai/out.png" } });
  });

  it("routes OpenAI-compatible Polza image models through image generations", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-imagegen-"));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl });

    const result = await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "openai/gpt-image-1", prompt: "draw", aspectRatio: "1:1", imageSize: "high" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://polza.ai/api/v2/images/generations", expect.objectContaining({
      body: expect.stringContaining("\"model\":\"gpt-image-1\"")
    }));
    expect(result.output).toMatchObject({ provider: "polza", model: "openai/gpt-image-1", image: { mimeType: "image/png" } });
  });

  it("routes DALL-E 3 through image generations", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-dalle-"));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl });

    await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "dall-e-3", prompt: "draw", aspectRatio: "9:16", size: "auto" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://polza.ai/api/v2/images/generations", expect.objectContaining({
      body: expect.stringContaining("\"model\":\"dall-e-3\"")
    }));
  });

  it("retries transient Polza upstream failures", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-retry-"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse("upstream connect error", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl, retryDelayMs: 1 });

    const result = await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "openai/gpt-5.4-image-2", prompt: "draw" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.output).toMatchObject({ provider: "polza", image: { mimeType: "image/png" } });
  });

  it("keeps remote image URL when provider CDN download times out", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-url-"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: "https://cdn.polza.ai/out.png" }] }))
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("Connect Timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl });

    const result = await runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "openai/gpt-5-image-mini", prompt: "draw", responseFormat: "url" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(result.output).toMatchObject({
      image: { originalUrl: "https://cdn.polza.ai/out.png", warning: expect.stringContaining("UND_ERR_CONNECT_TIMEOUT") },
      originalUrl: "https://cdn.polza.ai/out.png",
      status: "succeeded"
    });
  });
});
