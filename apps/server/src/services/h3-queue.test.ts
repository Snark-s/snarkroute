import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { H3QueueService, type H3QueueRuntime } from "./h3-queue";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function queueDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "snarkroute-h3-queue-"));
  directories.push(directory);
  return directory;
}

describe("H3QueueService", () => {
  it("persists local jobs and renders them sequentially before cleaning the managed instance", async () => {
    const events: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const runtime: H3QueueRuntime = {
      acquire: async () => {
        events.push("acquire");
        return { workerUrl: "https://worker.example", serviceToken: "secret", managedInstanceId: 42 };
      },
      render: async (item) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        events.push(`render:${item.id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return { workerJobId: `worker-${item.id}`, resultPaths: [`/results/${item.id}.mp4`] };
      },
      cleanup: async (lease) => { events.push(`cleanup:${lease.managedInstanceId}`); }
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const first = await service.create({ title: "Scene 1", operation: "text_to_video", prompt: "First scene" });
    const second = await service.create({ title: "Scene 2", operation: "text_to_video", prompt: "Second scene", seed: 123456 });

    expect(first.seed).toEqual(expect.any(Number));
    expect(first.seed).toBeGreaterThanOrEqual(0);
    expect(first.seed).toBeLessThanOrEqual(2_147_483_647);
    expect(second.seed).toBe(123456);

    await service.start("vast");
    const settled = await service.waitForSettled();

    expect(maxConcurrent).toBe(1);
    expect(events).toEqual(["acquire", `render:${first.id}`, `render:${second.id}`, "cleanup:42"]);
    expect(settled.session.status).toBe("completed");
    expect(settled.session.cleanupConfirmed).toBe(true);
    expect(settled.items.map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
    expect(settled.items.map((item) => item.seed)).toEqual([first.seed, 123456]);

    const reloaded = new H3QueueService({ directory: service.directory, runtime });
    expect((await reloaded.getState()).items.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it("destroys the managed instance when rendering fails", async () => {
    const events: string[] = [];
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "https://worker.example", serviceToken: "secret", managedInstanceId: 77 }),
      render: async () => { events.push("render"); throw new Error("GPU failed"); },
      cleanup: async (lease) => { events.push(`cleanup:${lease.managedInstanceId}`); }
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    await service.create({ title: "Broken", operation: "text_to_video", prompt: "Broken scene" });

    await service.start("vast");
    const settled = await service.waitForSettled();

    expect(events).toEqual(["render", "cleanup:77"]);
    expect(settled.items[0]?.status).toBe("failed");
    expect(settled.session.status).toBe("completed_with_errors");
    expect(settled.session.cleanupConfirmed).toBe(true);
  });

  it("persists and cleans the exact instance when startup fails after Vast creation", async () => {
    const events: string[] = [];
    const runtime: H3QueueRuntime = {
      acquire: async (_mode, onLease) => {
        await onLease({ workerUrl: "", serviceToken: "secret", managedInstanceId: 88, offerId: 7 });
        throw new Error("Worker readiness timed out");
      },
      render: async () => { throw new Error("must not render"); },
      cleanup: async (lease) => { events.push(`cleanup:${lease.managedInstanceId}`); }
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    await service.create({ title: "Startup failure", operation: "text_to_video", prompt: "Scene" });

    await service.start("vast");
    const settled = await service.waitForSettled();

    expect(events).toEqual(["cleanup:88"]);
    expect(settled.session.managedInstanceId).toBe(88);
    expect(settled.session.cleanupConfirmed).toBe(true);
    expect(settled.session.status).toBe("failed");
  });

  it("keeps the exact instance id visible when cleanup cannot be confirmed", async () => {
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "https://worker.example", serviceToken: "secret", managedInstanceId: 99 }),
      render: async (item) => ({ workerJobId: item.id, resultPaths: [] }),
      cleanup: async () => { throw new Error("Vast destroy was not confirmed"); }
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    await service.create({ title: "Scene", operation: "text_to_video", prompt: "Scene" });

    await service.start("vast");
    const settled = await service.waitForSettled();

    expect(settled.session.status).toBe("cleanup_failed");
    expect(settled.session.cleanupConfirmed).toBe(false);
    expect(settled.session.managedInstanceId).toBe(99);
    expect(settled.session.error).toContain("Vast destroy was not confirmed");
  });
});
