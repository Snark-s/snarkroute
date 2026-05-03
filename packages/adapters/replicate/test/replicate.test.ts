import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildClarityInput, createClarityUpscalerNodeRunner, createReplicateClient, estimateReplicateCost, prepareImageValue } from "../src/index";

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
    await expect(client.createPrediction("owner/model", {})).rejects.toThrow(/REPLICATE_API_TOKEN/);
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
