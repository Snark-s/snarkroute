import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor } from "@snarkroute/executor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildImageRequestBody, buildMediaImageRequestBody, buildMediaVideoRequestBody, createPolzaImageNodeRunner, createPolzaTextNodeRunner, createPolzaVideoNodeRunner, estimatePolzaPricingQuote, estimatePolzaPricingQuoteFromCatalog, normalizePolzaProviderCostFromUsage, polzaPricingCatalogFromModels, readPolzaPricingCatalogCache, refreshPolzaPricingCatalog } from "../src/index";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init
  });
}

describe("Polza adapter", () => {
  afterEach(() => {
    delete process.env.BOOJUM_RUB_PER_USD;
  });

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

  it("builds Wan video payload with video-specific parameters", () => {
    expect(buildMediaVideoRequestBody("wan/2.6", "pan across the skyline", { resolution: "1080p", duration: "10", multi_shots: "true", generate_audio: true }, [
      { type: "base64", data: "data:image/png;base64,aaa" },
      { type: "url", data: "https://cdn.polza.ai/reference.png" }
    ])).toMatchObject({
      model: "wan/2.6",
      input: {
        prompt: "pan across the skyline",
        resolution: "1080p",
        duration: "10",
        images: [
          { type: "base64", data: "data:image/png;base64,aaa" },
          { type: "url", data: "https://cdn.polza.ai/reference.png" }
        ],
        generate_audio: true,
        multi_shots: "true"
      },
      async: true
    });
  });

  it("accepts snake-case image parameters from the provider catalog", () => {
    expect(buildMediaImageRequestBody("google/gemini-3.1-flash-image-preview", "Убери сосну справа", {
      aspect_ratio: "16:9",
      imageResolution: "2K",
      quality: "high",
      output_format: "png",
      n: 1
    })).toMatchObject({
      model: "google/gemini-3.1-flash-image-preview",
      input: {
        prompt: "Убери сосну справа",
        aspect_ratio: "16:9",
        image_resolution: "2K",
        quality: "high",
        output_format: "png",
        max_images: 1
      }
    });
  });

  it("keeps schema parameters and all role-aware image, audio, and video inputs", () => {
    const body = buildMediaVideoRequestBody("kling/v2.6", "move", { aspect_ratio: "16:9", duration: "5", camera_control: "pan" }, [
      { type: "url", data: "https://cdn/first.png", role: "firstFrame", index: 0 },
      { type: "url", data: "https://cdn/last.png", role: "lastFrame", index: 0 }
    ], [{ type: "url", data: "https://cdn/audio.wav", role: "audio", index: 0 }], [{ type: "url", data: "https://cdn/motion.mp4", role: "sourceVideo", index: 0 }]) as { input: Record<string, unknown> };
    expect(body.input).toMatchObject({ aspect_ratio: "16:9", camera_control: "pan", images: expect.arrayContaining([expect.objectContaining({ role: "firstFrame" }), expect.objectContaining({ role: "lastFrame" })]), tail_image_url: { type: "url", data: "https://cdn/last.png" }, audios: [expect.objectContaining({ role: "audio" })], videos: [expect.objectContaining({ role: "sourceVideo" })] });
  });

  it("builds Kling 3 payload with its required mode and sound fields", () => {
    expect(buildMediaVideoRequestBody("kling/v3", "orbit @image 1 and transform into @image 2.", { resolution: "720p", duration: "5" }, [
      { type: "url", data: "https://cdn.polza.ai/start.png" },
      { type: "url", data: "https://cdn.polza.ai/end.png" }
    ])).toEqual({
      model: "kling/v3",
      input: {
        prompt: "orbit and transform into.",
        aspect_ratio: "1:1",
        duration: "5",
        images: [
          { type: "url", data: "https://cdn.polza.ai/start.png" },
          { type: "url", data: "https://cdn.polza.ai/end.png" }
        ],
        mode: "std",
        sound: "false"
      },
      async: true,
      user: undefined
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

  it("normalizes provider usage cost into USD from a single source", () => {
    process.env.BOOJUM_RUB_PER_USD = "80";

    expect(normalizePolzaProviderCostFromUsage({ cost: 4, currency: "RUB" })).toMatchObject({ amountUsd: 0.05, currency: "USD", sourceCurrency: "RUB" });
    expect(normalizePolzaProviderCostFromUsage({ cost: 4, currency: "USD" })).toMatchObject({ amountUsd: 4, currency: "USD", sourceCurrency: "USD" });
    expect(normalizePolzaProviderCostFromUsage({ cost: 4 }, { pricingCurrency: "RUB" })).toMatchObject({ amountUsd: 0.05, currency: "USD", sourceCurrency: "RUB" });
    expect(normalizePolzaProviderCostFromUsage({ cost: 4 })).toEqual({ amountUsd: null, currency: "unknown", sourceCurrency: "unknown" });
    expect(normalizePolzaProviderCostFromUsage({ cost_rub: 16.5 })).toMatchObject({ amountUsd: 0.20625, currency: "USD", sourceCurrency: "RUB" });
  });

  it("refreshes Polza pricing catalog when model catalog contains pricing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-polza-pricing-"));
    const cachePath = join(directory, "polza.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "openai/gpt-4o", top_provider: { pricing: { prompt: "0.1", completion: "0.2", currency: "RUB" } } }] }));
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
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hello" } }], usage: { cost: 0.1, currency: "USD" } }));
    const runner = createPolzaTextNodeRunner({ apiKey: "pza-test", fetchImpl });

    const result = await runner({
      node: { id: "text", type: "polza.text", params: {} },
      params: { model: "openai/gpt-4o", prompt: "hi" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://polza.ai/api/v1/chat/completions", expect.any(Object));
    expect(result.output).toMatchObject({ text: "hello", provider: "polza", model: "openai/gpt-4o" });
    expect(result.providerUsage).toMatchObject({ provider: "polza", actualCost: 0.1, actualCostCurrency: "USD" });
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
    process.env.BOOJUM_RUB_PER_USD = "80";
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
    expect(result.providerUsage).toMatchObject({ provider: "polza", actualCost: 0.01875, actualCostCurrency: "USD" });
  });

  it("falls back to the route estimate when Polza media usage cost has no known currency", async () => {
    process.env.BOOJUM_RUB_PER_USD = "80";
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-actual-cost-"));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
      usage: { cost: 4 }
    }));
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl }));

    const result = await executor.executeRoute({
      route: { id: "polza-cost", title: "Polza cost", version: "1.0.0" },
      nodes: [{ id: "image", type: "polza.image.generate", params: { model: "openai/gpt-5-image-mini", prompt: "draw" } }],
      edges: []
    }, { outputDirectory });

    expect(result.nodeResults.image.actualProviderCostAmount).toBeNull();
    expect(result.nodeResults.image.actualProviderCostCurrency).toBe("unknown");
    expect(result.nodeResults.image.actualCredits).toBe(4);
    expect(result.costSummary.totalActualCredits).toBe(4);
    expect(result.nodeResults.image.logs).toContain("Polza provider returned cost without an authoritative currency; using route estimate for credit capture.");
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

  it("surfaces Polza 402 provider response instead of assuming account balance", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-402-"));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Model is not enabled for this tariff" } }, { status: 402 }));
    const runner = createPolzaImageNodeRunner({ apiKey: "pza-test", fetchImpl });

    await expect(runner({
      node: { id: "image", type: "polza.image.generate", params: {} },
      params: { model: "openai/gpt-5.4-image-2", prompt: "draw" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    })).rejects.toThrow(/External Polza\.ai API rejected the request with status 402.*Endpoint: \/v1\/media.*API key fingerprint: .*Model is not enabled for this tariff.*not the Boojum credit balance/);
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

  it.each(["wan/2.6", "alibaba/happyhorse-1.1"])("passes the selected providerModelId through the generic video runner: %s", async (model) => {
    const video = {
      localPath: join(tmpdir(), `${model.replace("/", "-")}.mp4`),
      path: join(tmpdir(), `${model.replace("/", "-")}.mp4`),
      filename: `${model.replace("/", "-")}.mp4`,
      mimeType: "video/mp4",
      sizeBytes: 5,
      sourceNodeId: "video",
      model
    };
    const modelGateway = {
      invoke: vi.fn(async () => ({
        modelId: model,
        providerId: "polza",
        capability: "video.generate",
        output: { video, output: {}, request: { model }, model },
        raw: {}
      }))
    };
    const runner = createPolzaVideoNodeRunner({ modelGateway });

    const result = await runner({
      node: { id: "video", type: "polza.video.generate", params: {} },
      params: { model, prompt: "move slowly", images: [{ assetId: "asset_frame", path: "C:\\Temp\\input.png" }] },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    expect(modelGateway.invoke).toHaveBeenCalledWith(expect.objectContaining({
      capability: "video.generate",
      modelRef: `model://polza/${model}`,
      input: expect.objectContaining({ images: [expect.objectContaining({ assetId: "asset_frame" })] })
    }));
    expect(result.output).toMatchObject({ provider: "polza", model, video });
  });

  it("generates a video through Polza media and writes the returned asset", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-video-"));
    const inputFramePath = join(outputDirectory, "actual-input.png");
    await writeFile(inputFramePath, Buffer.from("png"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { url: "https://cdn.polza.ai/out.mp4" }, status: "completed" }))
      .mockResolvedValueOnce(new Response(Buffer.from("video"), { status: 200, headers: { "content-type": "video/mp4" } }));
    const runner = createPolzaVideoNodeRunner({ apiKey: "pza-test", fetchImpl });

    const result = await runner({
      node: { id: "video", type: "polza.video.generate", params: {} },
      params: { model: "wan/2.6", prompt: "move slowly", resolution: "1080p", duration: "10", images: [{ assetId: "asset_frame", path: inputFramePath, localPath: inputFramePath }] },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://polza.ai/api/v1/media", expect.objectContaining({
      body: expect.stringContaining("\"resolution\":\"1080p\"")
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://polza.ai/api/v1/media", expect.objectContaining({
      body: expect.stringContaining("\"duration\":\"10\"")
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://polza.ai/api/v1/media", expect.objectContaining({
      body: expect.stringContaining("data:image/png;base64,cG5n")
    }));
    expect(result.output).toMatchObject({ provider: "polza", video: { mimeType: "video/mp4", sizeBytes: 5 } });
  });

  it("maps schema-derived required video params to the Polza native input", () => {
    expect(buildMediaVideoRequestBody("kling/v2.6", "move", {
      aspect_ratio: "16:9",
      duration: "10",
      sound: "false",
      negative_prompt: "blur"
    })).toMatchObject({
      model: "kling/v2.6",
      input: {
        aspect_ratio: "16:9",
        duration: "10",
        sound: "false",
        negative_prompt: "blur"
      }
    });
  });

  it("maps the common camel-case aspect ratio alias without losing other params", () => {
    expect(buildMediaVideoRequestBody("vendor/video", "move", { aspectRatio: "9:16", seed: 42 })).toMatchObject({
      input: { aspect_ratio: "9:16", seed: 42 }
    });
  });

  it("polls a video generation when Polza returns its pending job token as text", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-polza-video-pending-"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: "pending (gen_2170492913)" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", data: { url: "https://cdn.polza.ai/out.mp4" } }))
      .mockResolvedValueOnce(new Response(Buffer.from("video"), { status: 200, headers: { "content-type": "video/mp4" } }));
    const runner = createPolzaVideoNodeRunner({ apiKey: "pza-test", fetchImpl, mediaPollIntervalMs: 1 });

    const result = await runner({
      node: { id: "video", type: "polza.video.generate", params: {} },
      params: { model: "wan/2.6", prompt: "fly through a doorway" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://polza.ai/api/v1/media/gen_2170492913", expect.any(Object));
    expect(result.output).toMatchObject({ video: { mimeType: "video/mp4", sizeBytes: 5 } });
  });
});
