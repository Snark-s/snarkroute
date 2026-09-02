import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canTransitionGenerationJob, generationRouteFromJob, ModelGatewayJobService, type GenerationJob } from "./service";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
describe("ModelGatewayJobService", () => {
  it("runs a provider-neutral request through the injected route executor and persists completion", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory) => ({ runId: "r", status: "succeeded", startedAt: "a", completedAt: "b", logs: [], provenance: {}, economics: {} as never, costSummary: {} as never, outputDirectory, nodeResults: { generate: { nodeId: "generate", type: "polza.video.generate", status: "succeeded", output: { video: { path: join(outputDirectory, "video.mp4"), filename: "video.mp4", mimeType: "video/mp4", resultUrl: "https://provider.example/result.mp4" }, provider: "polza", model: "wan/2.6", estimatedCost: 1, actualCost: null }, logs: [], startedAt: "a", completedAt: "b" } } }));
    const created = await service.create({ capability: "video.generate", nodeType: "polza.video.generate", modelId: "stored-wan", providerModelId: "wan/2.6", provider: "polza", prompt: "move", parameters: { duration: 5, nested: { apiKey: "must-not-be-logged" } } });
    let current = await service.get(created.id);
    for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", result: { modelId: "wan/2.6", provider: "polza" }, outputs: [{ resultUrl: "https://provider.example/result.mp4" }] });
    expect(JSON.stringify(log.mock.calls)).not.toContain("must-not-be-logged");
    expect(JSON.stringify(log.mock.calls)).toContain("[redacted]");
    log.mockRestore();
  });

  it("accepts OpenRouter video jobs through the ai.video.generate runner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-openrouter-video-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory) => ({ runId: "r", status: "succeeded", startedAt: "a", completedAt: "b", logs: [], provenance: {}, economics: {} as never, costSummary: {} as never, outputDirectory, nodeResults: { generate: { nodeId: "generate", type: "ai.video.generate", status: "succeeded", output: { video: { path: join(outputDirectory, "video.mp4"), filename: "video.mp4", mimeType: "video/mp4" }, provider: "openrouter", model: "kwaivgi/kling-v3.0-pro" }, logs: [], startedAt: "a", completedAt: "b" } } }));
    const created = await service.create({ capability: "video.generate", nodeType: "ai.video.generate", modelId: "kwaivgi/kling-v3.0-pro", providerModelId: "kwaivgi/kling-v3.0-pro", provider: "openrouter", prompt: "move" });
    let current = await service.get(created.id); for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", result: { modelId: "kwaivgi/kling-v3.0-pro", provider: "openrouter" } });
  });

  it("preserves the selected KIE provider route separately from canonical identity", () => {
    const job = { id: "gen_kie", status: "queued", createdAt: "now", updatedAt: "now", request: { capability: "video.generate", nodeType: "ai.video.generate", modelId: "kling-3.0-pro", providerModelId: "kling-3.0/video", provider: "kie", prompt: "move" } } as GenerationJob;
    expect(generationRouteFromJob(job).nodes[0]).toMatchObject({ type: "ai.video.generate", params: { model: "kling-3.0/video", providerModelId: "kling-3.0/video", provider: "kie", executionProvider: "kie" } });
  });

  it("maps the uploaded image asset to the selected Polza model image input", () => {
    const job = { id: "gen_00000000-0000-0000-0000-000000000000", status: "queued", createdAt: "now", updatedAt: "now", request: { capability: "video.generate", nodeType: "polza.video.generate", modelId: "stored-wan", providerModelId: "wan/2.6", provider: "polza", prompt: "move", inputs: [{ kind: "image", assetId: "asset_frame", path: "C:\\server\\asset_frame.png" }] } } as GenerationJob;
    expect(generationRouteFromJob(job).nodes[0]).toMatchObject({ type: "polza.video.generate", params: { model: "wan/2.6", images: [{ assetId: "asset_frame", path: "C:\\server\\asset_frame.png", localPath: "C:\\server\\asset_frame.png" }] } });
  });

  it("preserves every media input role and index for the provider runner", () => {
    const job = { id: "gen_multi", status: "queued", createdAt: "now", updatedAt: "now", request: { capability: "video.generate", nodeType: "polza.video.generate", modelId: "stored-kling", providerModelId: "kling/v3", provider: "polza", prompt: "move", inputs: [
      { kind: "image", role: "lastFrame", index: 0, assetId: "asset_last", path: "C:\\last.png" },
      { kind: "image", role: "firstFrame", index: 0, assetId: "asset_first", path: "C:\\first.png" },
      { kind: "image", role: "reference", index: 1, assetId: "asset_ref", path: "C:\\ref.png" },
      { kind: "audio", role: "audio", index: 0, assetId: "asset_audio", path: "C:\\sound.wav" },
      { kind: "video", role: "sourceVideo", index: 0, assetId: "asset_video", path: "C:\\motion.mp4" }
    ] } } as GenerationJob;
    expect(generationRouteFromJob(job).nodes[0].params).toMatchObject({
      images: [{ assetId: "asset_first", role: "firstFrame", index: 0 }, { assetId: "asset_last", role: "lastFrame", index: 0 }, { assetId: "asset_ref", role: "reference", index: 1 }],
      audios: [{ assetId: "asset_audio", role: "audio", index: 0 }],
      videos: [{ assetId: "asset_video", role: "sourceVideo", index: 0 }]
    });
  });

  it("runs image generation through the same job service and preserves multiple outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-image-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory) => ({ runId: "r", status: "succeeded", startedAt: "a", completedAt: "b", logs: [], provenance: {}, economics: {} as never, costSummary: {} as never, outputDirectory, nodeResults: { generate: { nodeId: "generate", type: "polza.image.generate", status: "succeeded", output: { images: [{ path: join(outputDirectory, "one.png"), filename: "one.png", mimeType: "image/png", width: 1024, height: 1024 }, { path: join(outputDirectory, "two.png"), filename: "two.png", mimeType: "image/png" }], provider: "polza", model: "gpt-image" }, logs: [], startedAt: "a", completedAt: "b" } } }));
    const created = await service.create({ capability: "image.generate", outputMediaType: "image", nodeType: "polza.image.generate", modelId: "gpt-image", providerModelId: "gpt-image", provider: "polza", prompt: "draw" });
    let current = await service.get(created.id); for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", outputMediaType: "image", result: { filename: "one.png" }, outputs: [{ kind: "image", role: "primary", index: 0, width: 1024 }, { kind: "image", role: "alternate", index: 1 }] });
  });

  it("runs local upscale through the same job API with zero provider cost and structured progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-local-upscale-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory, control) => {
      await control.onProgress(0.5, "tiled_inference");
      return { runId: "r", status: "succeeded", startedAt: "a", completedAt: "b", logs: [], provenance: {}, economics: {} as never, costSummary: {} as never, outputDirectory, nodeResults: { generate: { nodeId: "generate", type: "local_upscale", status: "succeeded", output: { image: { path: join(outputDirectory, "result.png"), filename: "result.png", mimeType: "image/png", width: 400, height: 200 }, provider: "local_upscale", model: "4x-test", estimatedCost: 0, actualCost: 0 }, logs: [], startedAt: "a", completedAt: "b" } } };
    });
    const created = await service.create({ capability: "image.upscale", nodeType: "local_upscale", outputMediaType: "image", modelId: "local_upscale/4x-test", providerModelId: "4x-test", provider: "local_upscale", inputs: [{ kind: "image", assetId: "asset_1", path: "C:\\input.png" }] });
    let current = await service.get(created.id); for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", progress: 1, result: { provider: "local_upscale", actualCost: 0 }, costs: { providerCost: 0, baseCost: 0 } });
  });

  it("persists a provider task id as soon as provider polling starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-provider-task-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory, control) => {
      await control.onProgress(0.05, "provider_job:task_kie_123");
      return successfulRun(outputDirectory);
    });
    const created = await service.create({ capability: "video.generate", nodeType: "ai.video.generate", modelId: "wan-2.6", providerModelId: "wan/2-6-text-to-video", provider: "kie" });
    let current = await service.get(created.id);
    for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", providerJobId: "task_kie_123" });
  });

  it("maps external image assets and parameters into an image-to-image runner", () => {
    const job = { id: "gen_00000000-0000-0000-0000-000000000001", status: "queued", createdAt: "now", updatedAt: "now", request: { capability: "image.generate", outputMediaType: "image", nodeType: "ai.image.generate", modelId: "openai/image", providerModelId: "openai/image", provider: "openrouter", prompt: "edit", parameters: { strength: 0.5 }, inputs: [{ kind: "image", role: "source", index: 0, assetId: "asset", path: "C:\\source.png" }] } } as GenerationJob;
    expect(generationRouteFromJob(job).nodes[0]).toMatchObject({ type: "ai.image.generate", params: { model: "openai/image", prompt: "edit", strength: 0.5, images: [{ assetId: "asset", path: "C:\\source.png", localPath: "C:\\source.png" }] } });
  });

  it("deduplicates create requests by idempotency key and preserves redacted host context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-idempotent-job-")); directories.push(directory);
    const execute = vi.fn(async (_job: GenerationJob, outputDirectory: string) => successfulRun(outputDirectory));
    const service = new ModelGatewayJobService(directory, execute);
    const request = { capability: "video.generate" as const, nodeType: "polza.video.generate", modelId: "wan", providerModelId: "wan", provider: "polza", idempotencyKey: "ae:comp-1:click-1", correlationId: "ae:comp-1", toolId: "tool.video", schemaVersion: "1.0", hostType: "after_effects" as const, sourceContext: { compositionId: 1, apiToken: "never-store-this" } };
    const first = await service.create(request);
    const second = await service.create(request);
    let completed = await service.get(first.id);
    for (let i = 0; i < 20 && completed?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); completed = await service.get(first.id); }
    expect(second.id).toBe(first.id);
    expect(second.request).toMatchObject({ toolId: "tool.video", hostType: "after_effects", sourceContext: { compositionId: 1, apiToken: "[redacted]" } });
    expect(JSON.stringify(second)).not.toContain("never-store-this");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("cancels an active job without publishing a late provider result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-cancel-job-")); directories.push(directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory) => { await gate; return successfulRun(outputDirectory); });
    const created = await service.create({ capability: "video.generate", nodeType: "polza.video.generate", modelId: "wan", providerModelId: "wan", provider: "polza" });
    const cancelled = await service.cancel(created.id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toMatchObject({ status: "cancelled" });
    const current = await service.get(created.id);
    expect(current).toMatchObject({ status: "cancelled" });
    expect(current?.result).toBeUndefined();
    expect(current?.costs).toBeUndefined();
  });

  it("aborts the in-flight provider control signal when cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-abort-job-")); directories.push(directory);
    let observedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory, control) => { observedSignal = control.signal; await gate; return successfulRun(outputDirectory); });
    const created = await service.create({ capability: "image.upscale", nodeType: "local_upscale", outputMediaType: "image", modelId: "local/4x", providerModelId: "4x", provider: "local_upscale", inputs: [{ kind: "image", assetId: "a", path: "C:\\a.png" }] });
    for (let i = 0; i < 20 && !observedSignal; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    await service.cancel(created.id);
    expect(observedSignal?.aborted).toBe(true);
    release();
  });

  it("allows an idempotent retry after provider failure without recording a charge", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-retry-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, vi.fn(async () => { throw new Error("worker disappeared"); }));
    const created = await service.create({ capability: "video.generate", nodeType: "polza.video.generate", modelId: "wan", providerModelId: "wan", provider: "polza" });
    let failed = await service.get(created.id);
    for (let i = 0; i < 20 && failed?.status !== "failed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); failed = await service.get(created.id); }
    expect(failed).toMatchObject({ status: "failed", error: "worker disappeared" });
    expect(failed?.costs).toBeUndefined();
    const retry = await service.retry(created.id, "retry:worker-disappeared");
    const duplicate = await service.retry(created.id, "retry:worker-disappeared");
    expect(retry).toMatchObject({ retry: { attempt: 2, sourceJobId: created.id } });
    expect(duplicate?.id).toBe(retry?.id);
    let retried = retry ? await service.get(retry.id) : null;
    for (let i = 0; i < 20 && retried?.status !== "failed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); retried = retry ? await service.get(retry.id) : null; }
  });

  it("enforces canonical job status transitions", () => {
    expect(canTransitionGenerationJob("queued", "starting_provider")).toBe(true);
    expect(canTransitionGenerationJob("starting_provider", "generating_768p")).toBe(true);
    expect(canTransitionGenerationJob("generating", "downloading")).toBe(true);
    expect(canTransitionGenerationJob("completed", "generating")).toBe(false);
    expect(canTransitionGenerationJob("cancelled", "completed")).toBe(false);
  });
});

function successfulRun(outputDirectory: string) {
  return { runId: "r", status: "succeeded" as const, startedAt: "a", completedAt: "b", logs: [], provenance: {}, economics: {} as never, costSummary: {} as never, outputDirectory, nodeResults: { generate: { nodeId: "generate", type: "polza.video.generate", status: "succeeded" as const, output: { video: { path: join(outputDirectory, "video.mp4"), filename: "video.mp4", mimeType: "video/mp4" }, provider: "polza", model: "wan" }, logs: [], startedAt: "a", completedAt: "b" } } };
}
