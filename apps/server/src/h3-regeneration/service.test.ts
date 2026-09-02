import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createH3RegenerationClient } from "@snarkroute/h3";
import { H3RegenerationService } from "./service";
import type { PortableToolJob } from "../tool-jobs/service";

const directories: string[] = [];

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("H3RegenerationService", () => {
  it("deduplicates a selected 768p result and preserves source context and pricing", async () => {
    const setup = await fixture();
    const run = vi.fn(async () => ({ id: "provider-1", url: "https://cdn.minimax.io/result.mp4" }));
    const client = { configured: true, run, download: vi.fn(async () => new Uint8Array([4, 5, 6]).buffer) } as unknown as ReturnType<typeof createH3RegenerationClient>;
    const service = new H3RegenerationService(setup.jobsDirectory, { get: async () => setup.source }, client);
    const [first, duplicate] = await Promise.all([service.create({ sourceToolJobId: setup.source.id, resultId: "video:0", idempotencyKey: "double-click" }), service.create({ sourceToolJobId: setup.source.id, resultId: "video:0", idempotencyKey: "double-click" })]);
    expect(duplicate.id).toBe(first.id);
    const completed = await waitFor(service, first.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(completed).toMatchObject({ status: "completed", sourceContext: { compositionId: 42 }, costs: { providerUsd: 0.25 }, result: { type: "video" } });
    expect(completed?.result?.filename).toMatch(/\.mp4$/);
  });

  it("does not record costs when the provider fails", async () => {
    const setup = await fixture();
    const client = { configured: true, run: vi.fn(async () => { throw new Error("provider unavailable"); }), download: vi.fn() } as unknown as ReturnType<typeof createH3RegenerationClient>;
    const service = new H3RegenerationService(setup.jobsDirectory, { get: async () => setup.source }, client);
    const created = await service.create({ sourceToolJobId: setup.source.id, resultId: "video:0" });
    const failed = await waitFor(service, created.id);
    expect(failed).toMatchObject({ status: "failed", error: "provider unavailable" });
    expect(failed?.costs).toBeUndefined();
  });
});

async function fixture() {
  await mkdir(resolve(process.cwd(), "data"), { recursive: true });
  const directory = await mkdtemp(join(resolve(process.cwd(), "data"), "h3-regen-test-"));
  directories.push(directory);
  const videoPath = join(directory, "source.mp4");
  await writeFile(videoPath, new Uint8Array([1, 2, 3]));
  const source: PortableToolJob = {
    id: "tool_source", status: "completed", progress: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), selectedResultId: "video:0",
    request: { toolId: "minimax.h3.generate", schemaVersion: "1.0", hostType: "after_effects", parameters: { prompt: "original context", duration: 5 }, sourceContext: { compositionId: 42 } },
    results: [{ id: "video:0", outputId: "video", type: "video", label: "768p", url: `/api/assets/preview?kind=video&path=${encodeURIComponent(videoPath)}` }]
  };
  return { source, jobsDirectory: join(directory, "jobs") };
}

async function waitFor(service: H3RegenerationService, id: string) {
  for (let index = 0; index < 50; index++) { const job = await service.get(id); if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job; await new Promise((resolveWait) => setTimeout(resolveWait, 5)); }
  throw new Error("regeneration test timed out");
}
