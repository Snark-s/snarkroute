import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generationRouteFromJob, ModelGatewayJobService, type GenerationJob } from "./service";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
describe("ModelGatewayJobService", () => {
  it("runs a provider-neutral request through the injected route executor and persists completion", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory) => ({ runId: "r", status: "succeeded", startedAt: "a", completedAt: "b", logs: [], provenance: {}, economics: {} as never, costSummary: {} as never, outputDirectory, nodeResults: { generate: { nodeId: "generate", type: "polza.video.generate", status: "succeeded", output: { video: { path: join(outputDirectory, "video.mp4"), filename: "video.mp4", mimeType: "video/mp4" }, provider: "polza", model: "wan/2.6", estimatedCost: 1, actualCost: null }, logs: [], startedAt: "a", completedAt: "b" } } }));
    const created = await service.create({ capability: "video.generate", nodeType: "polza.video.generate", modelId: "stored-wan", providerModelId: "wan/2.6", provider: "polza", prompt: "move", parameters: { duration: 5, nested: { apiKey: "must-not-be-logged" } } });
    let current = await service.get(created.id);
    for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", result: { modelId: "wan/2.6", provider: "polza" } });
    expect(JSON.stringify(log.mock.calls)).not.toContain("must-not-be-logged");
    expect(JSON.stringify(log.mock.calls)).toContain("[redacted]");
    log.mockRestore();
  });

  it("maps the uploaded image asset to the selected Polza model image input", () => {
    const job = { id: "gen_00000000-0000-0000-0000-000000000000", status: "queued", createdAt: "now", updatedAt: "now", request: { capability: "video.generate", nodeType: "polza.video.generate", modelId: "stored-wan", providerModelId: "wan/2.6", provider: "polza", prompt: "move", inputs: [{ kind: "image", assetId: "asset_frame", path: "C:\\server\\asset_frame.png" }] } } as GenerationJob;
    expect(generationRouteFromJob(job).nodes[0]).toMatchObject({ type: "polza.video.generate", params: { model: "wan/2.6", images: [{ assetId: "asset_frame", path: "C:\\server\\asset_frame.png", localPath: "C:\\server\\asset_frame.png" }] } });
  });

  it("runs image generation through the same job service and preserves multiple outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-image-job-")); directories.push(directory);
    const service = new ModelGatewayJobService(directory, async (_job, outputDirectory) => ({ runId: "r", status: "succeeded", startedAt: "a", completedAt: "b", logs: [], provenance: {}, economics: {} as never, costSummary: {} as never, outputDirectory, nodeResults: { generate: { nodeId: "generate", type: "polza.image.generate", status: "succeeded", output: { images: [{ path: join(outputDirectory, "one.png"), filename: "one.png", mimeType: "image/png", width: 1024, height: 1024 }, { path: join(outputDirectory, "two.png"), filename: "two.png", mimeType: "image/png" }], provider: "polza", model: "gpt-image" }, logs: [], startedAt: "a", completedAt: "b" } } }));
    const created = await service.create({ capability: "image.generate", outputMediaType: "image", nodeType: "polza.image.generate", modelId: "gpt-image", providerModelId: "gpt-image", provider: "polza", prompt: "draw" });
    let current = await service.get(created.id); for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", outputMediaType: "image", result: { filename: "one.png" }, outputs: [{ kind: "image", role: "primary", index: 0, width: 1024 }, { kind: "image", role: "alternate", index: 1 }] });
  });

  it("maps external image assets and parameters into an image-to-image runner", () => {
    const job = { id: "gen_00000000-0000-0000-0000-000000000001", status: "queued", createdAt: "now", updatedAt: "now", request: { capability: "image.generate", outputMediaType: "image", nodeType: "ai.image.generate", modelId: "openai/image", providerModelId: "openai/image", provider: "openrouter", prompt: "edit", parameters: { strength: 0.5 }, inputs: [{ kind: "image", role: "source", index: 0, assetId: "asset", path: "C:\\source.png" }] } } as GenerationJob;
    expect(generationRouteFromJob(job).nodes[0]).toMatchObject({ type: "ai.image.generate", params: { model: "openai/image", prompt: "edit", strength: 0.5, images: [{ assetId: "asset", path: "C:\\source.png", localPath: "C:\\source.png" }] } });
  });
});
