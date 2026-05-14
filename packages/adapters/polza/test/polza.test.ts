import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildImageRequestBody, buildMediaImageRequestBody, createPolzaImageNodeRunner, createPolzaTextNodeRunner } from "../src/index";

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
    expect(buildMediaImageRequestBody("openai/gpt-5.4-image-2", "draw", { aspectRatio: "16:9", imageSize: "2K", quality: "high", outputFormat: "png" })).toMatchObject({
      model: "openai/gpt-5.4-image-2",
      input: {
        prompt: "draw",
        aspect_ratio: "16:9",
        n: 1
      },
      async: false
    });
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
