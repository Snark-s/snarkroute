import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalVideoUpscaleNodeRunner, createLocalVideoUpscaleWorkerClient } from "../src/index";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("local video upscale adapter", () => {
  it("reads the live video model catalog from the shared authenticated worker", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
      return Response.json({ models: [{ id: "nanovsr-644k-x4", temporal: true }], parameters: [] });
    }) as unknown as typeof fetch;
    const client = createLocalVideoUpscaleWorkerClient({ baseUrl: "http://worker", serviceToken: "secret", fetchImpl });
    expect(await client.capabilities()).toMatchObject({ models: [{ temporal: true }] });
  });

  it("uploads, polls, downloads, and publishes a standard video asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-local-video-")); directories.push(directory);
    const input = join(directory, "input.mp4"); await writeFile(input, Buffer.from("input-video"));
    const fetchImpl = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/assets")) return Response.json({ id: "video_asset_1" });
      if (value.endsWith("/jobs") && !value.includes("vup_")) return Response.json({ id: "vup_1", status: "queued" });
      if (value.endsWith("/jobs/vup_1")) return Response.json({ id: "vup_1", status: "succeeded", output: { width: 640, height: 360, duration: 1, bytes: 12, temporal: true } });
      if (value.endsWith("/content")) return new Response(Buffer.from("output-video"));
      throw new Error(value);
    }) as unknown as typeof fetch;
    const runner = createLocalVideoUpscaleNodeRunner({ baseUrl: "http://worker", serviceToken: "secret", fetchImpl, pollingIntervalMs: 1 });
    const result = await runner({
      node: { id: "upscale", type: "local_video_upscale", params: {} }, params: { model: "nanovsr-644k-x4" },
      inputs: { video: { path: input, mimeType: "video/mp4" } },
      context: { runId: "r", route: {} as never, outputDirectory: directory, nodeOutputs: {}, log: () => undefined }
    });
    expect(result.output).toMatchObject({ provider: "local_video_upscale", actualCost: 0, video: { width: 640, temporal: true } });
    expect(await readFile(String((result.output.video as { path: string }).path), "utf8")).toBe("output-video");
  });
});
