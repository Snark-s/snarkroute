import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { H3QueueService } from "./h3-queue";

it("trashes deleted renders, collects old orphan folders and empties only the trash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h3-trash-"));
  try {
    const service = new H3QueueService({ directory, runtime: {
      acquire: async () => ({ workerUrl: "http://worker", serviceToken: "test" }),
      render: async () => ({ workerJobId: "job", resultPaths: [] }),
      cleanup: async () => {},
    } });
    const removed = await service.create({ title: "Delete", operation: "text_to_video", prompt: "Scene" });
    const kept = await service.create({ title: "Keep", operation: "text_to_video", prompt: "Scene" });
    for (const id of [removed.id, kept.id, "h3q_old"]) {
      await mkdir(join(directory, "results", id), { recursive: true });
      await writeFile(join(directory, "results", id, "video.mp4"), "render");
    }
    await service.remove(removed.id);
    expect(await readdir(join(directory, "results"))).not.toContain(removed.id);
    expect(await readdir(join(directory, ".trash", "results"))).toHaveLength(1);
    expect(await service.collectOrphanResults()).toEqual({ movedCount: 1 });
    expect(await service.emptyTrash()).toEqual({ deletedCount: 2 });
    expect(await readFile(join(directory, "results", kept.id, "video.mp4"), "utf8")).toBe("render");
    expect(await service.emptyTrash()).toEqual({ deletedCount: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("preserves results reused by another task and trashes them after its removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h3-trash-"));
  try {
    const service = new H3QueueService({ directory, runtime: {
      acquire: async () => ({ workerUrl: "http://worker", serviceToken: "test" }),
      render: async () => ({ workerJobId: "job", resultPaths: [] }),
      cleanup: async () => {},
    } });
    const source = await service.create({ title: "Source", operation: "text_to_video", prompt: "Scene" });
    const path = join(directory, "results", source.id, "video.mp4");
    await mkdir(join(directory, "results", source.id), { recursive: true });
    await writeFile(path, "render");
    await service.start("saved_worker");
    await service.waitForSettled();
    const dependent = await service.create({ title: "Reuse", operation: "motion_transfer", prompt: "Scene", assets: [{ slot: "sourceVideo", kind: "video", path, filename: "video.mp4", mimeType: "video/mp4" }] });
    await service.clearFinished();
    expect((await service.getState()).items.map((item) => item.id)).toEqual([dependent.id]);
    expect(await service.collectOrphanResults()).toEqual({ movedCount: 0 });
    expect(await readFile(path, "utf8")).toBe("render");
    await service.remove(dependent.id);
    expect(await service.collectOrphanResults()).toEqual({ movedCount: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
