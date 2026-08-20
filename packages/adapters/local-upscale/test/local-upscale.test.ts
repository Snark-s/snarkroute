import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalUpscaleNodeRunner, createLocalUpscaleWorkerClient, LocalUpscaleProviderError } from "../src/index";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("local upscale adapter", () => {
  it("publishes worker capabilities without exposing the service token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
      return Response.json({ models: [{ id: "4x-test" }], parameters: [] });
    }) as unknown as typeof fetch;
    const client = createLocalUpscaleWorkerClient({ baseUrl: "http://worker", serviceToken: "secret", fetchImpl });
    expect(await client.capabilities()).toMatchObject({ models: [{ id: "4x-test" }] });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('"serviceToken"');
  });

  it("runs the node through upload, poll and lossless download with zero API cost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-local-upscale-")); directories.push(directory);
    const input = join(directory, "input.png"); await writeFile(input, Buffer.from("png"));
    let polls = 0;
    const fetchImpl = vi.fn(async (urlValue: string | URL | Request) => {
      const url = String(urlValue);
      if (url.endsWith("/v1/assets")) return Response.json({ id: "asset_1" });
      if (url.endsWith("/v1/jobs")) return Response.json({ id: "up_1", status: "queued", progress: 0 });
      if (url.endsWith("/v1/jobs/up_1/content")) return new Response(Buffer.from("result"), { headers: { "content-type": "image/png" } });
      polls++;
      return Response.json({ id: "up_1", status: "succeeded", progress: 1, output: { filename: "result.png", mime_type: "image/png", width: 8, height: 8, bytes: 6 } });
    }) as unknown as typeof fetch;
    const runner = createLocalUpscaleNodeRunner({ baseUrl: "http://worker", serviceToken: "secret", fetchImpl, pollingIntervalMs: 0 });
    const result = await runner({ node: { id: "upscale", type: "local_upscale", params: {} }, params: { model: "4x-test", images: [{ path: input }] }, inputs: {}, context: { runId: "r", route: {} as never, outputDirectory: directory, nodeOutputs: {}, log: () => undefined } });
    expect(result).toMatchObject({ output: { provider: "local_upscale", actualCost: 0, image: { mimeType: "image/png", width: 8 } }, providerUsage: { actualCost: 0 } });
    expect(await readFile((result.output as { image: { path: string } }).image.path, "utf8")).toBe("result");
    expect(polls).toBe(1);
  });

  it("keeps structured worker errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: "missing_weights", message: "weights missing", retryable: false, details: { model: "x" } } }), { status: 409 })) as unknown as typeof fetch;
    const client = createLocalUpscaleWorkerClient({ baseUrl: "http://worker", serviceToken: "secret", fetchImpl });
    await expect(client.create({})).rejects.toMatchObject({ name: "LocalUpscaleProviderError", code: "missing_weights", retryable: false });
    await expect(client.create({})).rejects.toBeInstanceOf(LocalUpscaleProviderError);
  });
});
