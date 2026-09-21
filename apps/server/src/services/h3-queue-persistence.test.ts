import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { H3QueueService } from "./h3-queue";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

it("retries a Windows sharing violation without losing the render result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h3-persist-"));
  try {
    const service = new H3QueueService({ directory, runtime: {
      acquire: async () => ({ workerUrl: "http://worker", serviceToken: "test" }),
      render: async (_item, _lease, progress) => {
        vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }));
        await progress(0.2, "models_loaded");
        return { workerJobId: "job", resultPaths: ["result.mp4"] };
      },
      cleanup: async () => {},
    }});
    await service.create({ title: "Scene", operation: "text_to_video", prompt: "Scene" });
    await service.start("saved_worker");
    expect((await service.waitForSettled()).items[0]?.status).toBe("succeeded");
    expect(JSON.parse(await readFile(join(directory, "queue.json"), "utf8")).session.status).toBe("completed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("falls back to an in-place snapshot when Windows keeps denying replacement renames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h3-persist-"));
  const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  try {
    const service = new H3QueueService({ directory, runtime: {
      acquire: async () => ({ workerUrl: "http://worker", serviceToken: "test" }),
      render: async () => ({ workerJobId: "job", resultPaths: ["result.mp4"] }),
      cleanup: async () => {},
    }});
    await service.create({ title: "Scene", operation: "text_to_video", prompt: "Scene" });
    vi.mocked(rename).mockImplementation(realFs.rename);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }));
    }
    await service.start("saved_worker");
    expect((await service.waitForSettled()).items[0]?.status).toBe("succeeded");
    expect(JSON.parse(await readFile(join(directory, "queue.json"), "utf8")).items[0].status).toBe("succeeded");
  } finally {
    vi.mocked(rename).mockImplementation(realFs.rename);
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps a terminal error in memory when final persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h3-persist-"));
  try {
    const service = new H3QueueService({ directory, runtime: {
      acquire: async () => ({ workerUrl: "http://worker", serviceToken: "test" }),
      render: async () => ({ workerJobId: "job", resultPaths: ["result.mp4"] }),
      cleanup: async () => {
        vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      },
    }});
    await service.create({ title: "Scene", operation: "text_to_video", prompt: "Scene" });
    await service.start("saved_worker");
    const state = await service.waitForSettled();
    expect(state.session.status).toBe("failed");
    expect(state.session.error).toContain("disk full");
    expect(state.items[0]?.status).toBe("succeeded");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
