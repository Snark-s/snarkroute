import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor } from "@snarkroute/executor";
import { describe, expect, it, vi } from "vitest";
import { buildClarityInput, createClarityUpscalerNodeRunner, createReplicateClient, createReplicateNodeRunner, createReplicateProviderAdapter, estimateReplicateCost, prepareImageValue } from "../src/index";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("Replicate client", () => {
  it("creates a prediction", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ latest_version: { id: "version-1" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "starting" }));
    const client = createReplicateClient({ token: "token", fetchImpl });
    await expect(client.createPrediction("owner/model", { prompt: "hi" })).resolves.toMatchObject({ id: "p1" });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/predictions"), expect.objectContaining({ method: "POST" }));
    expect(fetchImpl.mock.calls[1][1].body).toContain('"version":"version-1"');
  });

  it("polls until a prediction succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ latest_version: { id: "version-1" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "processing" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "succeeded", output: ["ok"], urls: { web: "https://replicate.com/p/p1" } }));
    const client = createReplicateClient({ token: "token", fetchImpl });
    const result = await client.runPrediction("owner/model", { prompt: "hi" }, { pollingIntervalMs: 1 });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual(["ok"]);
  });

  it("returns failed prediction details", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ latest_version: { id: "version-1" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "processing" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "failed", error: "bad input" }));
    const client = createReplicateClient({ token: "token", fetchImpl });
    const result = await client.runPrediction("owner/model", {}, { pollingIntervalMs: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("bad input");
  });

  it("fails clearly without a token", async () => {
    const client = createReplicateClient({ token: "" });
    await expect(client.createPrediction("owner/model", {})).rejects.toThrow("REPLICATE_API_TOKEN is not configured.\nOpen Settings \u2192 Secrets \u2192 Replicate and paste your token.");
  });

  it("converts a local image path to a data URI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-replicate-"));
    const imagePath = join(directory, "tiny.png");
    await writeFile(imagePath, Buffer.from("png"));
    await expect(prepareImageValue(imagePath)).resolves.toMatch(/^data:image\/png;base64,/);
  });

  it("builds clarity input from params and image", async () => {
    const input = await buildClarityInput({ scale_factor: 2, creativity: 0.25 }, "https://example.com/in.png");
    expect(input).toMatchObject({ image: "https://example.com/in.png", scale_factor: 2, creativity: 0.25 });
  });

  it("clarity node downloads output URL into an image object", async () => {
    const imageBytes = Buffer.from("image");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ latest_version: { id: "version-1" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "succeeded", output: ["https://example.com/out.webp"], metrics: { predict_time: 1 } }))
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength)
      } as Response);
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-clarity-"));
    const runner = createClarityUpscalerNodeRunner({ token: "token", fetchImpl });
    const result = await runner({
      node: { id: "upscale", type: "replicate.clarity-upscaler", params: {} },
      params: { image: "https://example.com/in.png" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });
    expect(result.output).toMatchObject({ predictionId: "p1", status: "succeeded", image: { originalUrl: "https://example.com/out.webp", mimeType: "image/webp" } });
    expect(result.providerUsage).toMatchObject({ provider: "replicate", model: "philz1337x/clarity-upscaler", externalId: "p1", status: "succeeded" });
    expect(JSON.stringify(result.providerUsage)).not.toContain("token");
  });

  it("clarity node prefers connected prompt input over params.prompt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ latest_version: { id: "version-1" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "succeeded", output: ["https://example.com/out.webp"] }))
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
      } as Response);
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-clarity-prompt-"));
    const runner = createClarityUpscalerNodeRunner({ token: "token", fetchImpl });
    await runner({
      node: { id: "upscale", type: "replicate.clarity-upscaler", params: {} },
      params: { prompt: "panel prompt" },
      inputs: { image: "https://example.com/in.png", prompt: "connected prompt" },
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(body.input.prompt).toBe("connected prompt");
  });

  it("replicate.clarity-upscaler runner is registered without a token and fails clearly", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("replicate.clarity-upscaler", createClarityUpscalerNodeRunner({ token: "" }));
    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "clarity-missing-token", title: "Clarity Missing Token", author: {} },
        nodes: [
          { id: "upscale", type: "replicate.clarity-upscaler", params: { image: "https://example.com/in.png" } }
        ],
        edges: []
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-clarity-missing-token-")) }
    );

    expect(result.status).toBe("failed");
    expect(result.nodeResults.upscale.error).toContain("REPLICATE_API_TOKEN is not configured.\nOpen Settings \u2192 Secrets \u2192 Replicate and paste your token.");
    expect(result.nodeResults.upscale.error).not.toContain("No runner registered");
  });

  it("replicate.model runner is registered without a token and fails clearly", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("replicate.model", createReplicateNodeRunner({ token: "" }));
    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "replicate-missing-token", title: "Replicate Missing Token", author: {} },
        nodes: [
          { id: "generate", type: "replicate.model", params: { model: "owner/model", input: { prompt: "hi" } } }
        ],
        edges: []
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-replicate-missing-token-")) }
    );

    expect(result.status).toBe("failed");
    expect(result.nodeResults.generate.error).toContain("REPLICATE_API_TOKEN is not configured.\nOpen Settings \u2192 Secrets \u2192 Replicate and paste your token.");
    expect(result.nodeResults.generate.error).not.toContain("No runner registered");
  });

  it("replicate.model calls Model Gateway instead of invoking the provider directly", async () => {
    const modelGateway = {
      invoke: vi.fn(async () => ({
        modelId: "owner/model",
        providerId: "replicate",
        capability: "image.generate",
        output: {
          predictionId: "p1",
          output: ["ok"],
          status: "succeeded",
          metrics: { predict_time: 1 },
          webUrl: "https://replicate.com/p/p1"
        },
        raw: {
          predictionId: "p1",
          model: "owner/model",
          input: { prompt: "hi" },
          output: ["ok"],
          status: "succeeded",
          metrics: { predict_time: 1 },
          webUrl: "https://replicate.com/p/p1"
        }
      }))
    };
    const runner = createReplicateNodeRunner({ modelGateway });
    const result = await runner({
      node: { id: "generate", type: "replicate.model", params: {} },
      params: { model: "owner/model", input: { prompt: "hi" } },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
    });

    expect(modelGateway.invoke).toHaveBeenCalledWith(expect.objectContaining({
      capability: "image.generate",
      modelRef: "model://replicate/owner/model",
      input: { prompt: "hi" },
      metadata: { nodeId: "generate", nodeType: "replicate.model" }
    }));
    expect(result.providerUsage).toMatchObject({ provider: "replicate", model: "owner/model", externalId: "p1", status: "succeeded" });
  });

  it("Replicate provider adapter does not require raw API keys in node settings", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ latest_version: { id: "version-1" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "succeeded", output: ["ok"], metrics: { predict_time: 1 } }));
    const adapter = createReplicateProviderAdapter({ token: "token", fetchImpl });
    await expect(adapter.invoke({
      capability: "image.generate",
      modelRef: "model://replicate/owner/model",
      model: { id: "owner/model", providerId: "replicate", title: "owner/model", capabilities: ["image.generate"] },
      input: { prompt: "hi" }
    }, { providerId: "replicate", enabled: true, credentialRef: "provider.replicate.default" })).resolves.toMatchObject({
      providerId: "replicate",
      modelId: "owner/model"
    });
  });

  it("estimates cost from prediction metrics", () => {
    expect(estimateReplicateCost({ predict_time: 10 }, 0.0014)).toMatchObject({
      estimated: true,
      currency: "USD",
      seconds: 10,
      usdPerSecond: 0.0014,
      amountUsd: 0.014
    });
  });

  it("clarity node fails clearly without image input", async () => {
    const runner = createClarityUpscalerNodeRunner({ token: "token", fetchImpl: vi.fn() });
    await expect(
      runner({
        node: { id: "upscale", type: "replicate.clarity-upscaler", params: {} },
        params: {},
        inputs: {},
        context: { runId: "r", route: {} as never, outputDirectory: tmpdir(), nodeOutputs: {}, log: () => undefined }
      })
    ).rejects.toThrow(/requires an image input/);
  });
});
