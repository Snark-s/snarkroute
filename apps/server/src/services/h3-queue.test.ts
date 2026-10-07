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
  it("persists per-render attention mode and defaults old jobs to auto", async () => {
    const directory = await queueDirectory();
    const runtime: H3QueueRuntime = { acquire: async () => ({ workerUrl: "", serviceToken: "" }), render: async () => ({ workerJobId: "unused", resultPaths: [] }), cleanup: async () => undefined };
    const service = new H3QueueService({ directory, runtime });
    const dense = await service.create({ title: "Dense A/B", operation: "text_to_video", prompt: "Scene", attentionMode: "dense" });
    const automatic = await service.create({ title: "Auto", operation: "text_to_video", prompt: "Scene" });
    expect(dense.attentionMode).toBe("dense");
    expect(automatic.attentionMode).toBe("auto");
    expect((await new H3QueueService({ directory, runtime }).getState()).items.map((item) => item.attentionMode)).toEqual(["dense", "auto"]);
  });

  it("persists visual modifiers, clears them, and rejects non-Base combinations", async () => {
    const directory = await queueDirectory();
    const runtime: H3QueueRuntime = { acquire: async () => ({ workerUrl: "", serviceToken: "" }), render: async () => ({ workerJobId: "unused", resultPaths: [] }), cleanup: async () => undefined };
    const service = new H3QueueService({ directory, runtime });
    const visualModifier = { id: "authentic_cinematic_texture" as const, enabled: true as const, strength: 0.5, includeTrigger: false };
    const item = await service.create({ title: "Texture", operation: "text_to_video", prompt: "Scene", modelVariant: "h3_base", visualModifier });
    expect((await new H3QueueService({ directory, runtime }).getState()).items[0].visualModifier).toEqual(visualModifier);
    await expect(service.create({ title: "Hosted", operation: "text_to_video", prompt: "Scene", modelVariant: "h3_max_turbo", visualModifier })).rejects.toThrow("requires h3_base");
    await expect(service.create({ title: "Combined", operation: "text_to_video", prompt: "Scene", visualModifier, identityTransfer: { enabled: true, strength: 1 } })).rejects.toThrow("cannot be combined");
    const cleared = await service.update(item.id, { visualModifier: undefined });
    expect(cleared?.visualModifier).toBeUndefined();
  });
  it("keeps hosted H3 Max as a model profile and stores provider result metadata", async () => {
    const events: string[] = [];
    const runtime: H3QueueRuntime = {
      acquire: async (mode, _onLease, items) => {
        events.push(`acquire:${mode}:${items.map((item) => item.modelVariant).join(",")}`);
        return { workerUrl: "", serviceToken: "", provider: "fal" };
      },
      render: async (item) => ({ workerJobId: `fal-${item.id}`, resultPaths: [`/results/${item.id}.mp4`], metadata: { provider: "fal", model: "fal/minimax-h3-max", estimatedCostUsd: 0.2, latencyMs: { total: 2500 } } }),
      cleanup: async () => undefined
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const item = await service.create({ title: "Hosted scene", operation: "text_to_video", prompt: "Scene", duration: 5, modelVariant: "h3_max", variants: 1 });

    await service.start("provider");
    const settled = await service.waitForSettled();

    expect(item.modelVariant).toBe("h3_max");
    expect(item.inferenceSteps).toBeUndefined();
    expect(events).toEqual(["acquire:provider:h3_max"]);
    expect(settled.items[0]).toMatchObject({ status: "succeeded", resultMetadata: { provider: "fal", model: "fal/minimax-h3-max", estimatedCostUsd: 0.2 } });
  });

  it("keeps hosted H3 Max Turbo as a provider-only profile", async () => {
    const events: string[] = [];
    const runtime: H3QueueRuntime = {
      acquire: async (mode, _onLease, items) => { events.push(`acquire:${mode}:${items.map((item) => item.modelVariant).join(",")}`); return { workerUrl: "", serviceToken: "", provider: "fal" }; },
      render: async (item) => ({ workerJobId: `fal-${item.id}`, resultPaths: [`/results/${item.id}.mp4`], metadata: { provider: "fal", model: "fal/minimax-h3-max-turbo", estimatedCostUsd: 0.2 } }),
      cleanup: async () => undefined
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const item = await service.create({ title: "Turbo preview", operation: "text_to_video", prompt: "Scene", duration: 5, modelVariant: "h3_max_turbo", variants: 1 });

    await service.start("provider");
    const settled = await service.waitForSettled();

    expect(item.modelVariant).toBe("h3_max_turbo");
    expect(item.inferenceSteps).toBeUndefined();
    expect(events).toEqual(["acquire:provider:h3_max_turbo"]);
    expect(settled.items[0]).toMatchObject({ status: "succeeded", resultMetadata: { model: "fal/minimax-h3-max-turbo", estimatedCostUsd: 0.2 } });
  });

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

  it("accepts and persists a video style-transfer job", async () => {
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "https://worker.example", serviceToken: "secret" }),
      render: async (item) => ({ workerJobId: item.id, resultPaths: [] }),
      cleanup: async () => undefined
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const item = await service.create({
      title: "Voxel restyle",
      operation: "style_transfer",
      prompt: "Video 1 sets motion and camera. Image 1 sets the visual style.",
      assets: [
        { slot: "referenceVideo", kind: "video", path: "/inputs/source.mp4", filename: "source.mp4", mimeType: "video/mp4" },
        { slot: "referenceImage", kind: "image", path: "/inputs/style.png", filename: "style.png", mimeType: "image/png" }
      ]
    });

    const reloaded = new H3QueueService({ directory: service.directory, runtime });
    expect((await reloaded.getState()).items[0]).toMatchObject({ id: item.id, operation: "style_transfer" });
  });

  it("persists an imported Ref2VA job with materialized TrainScene references", async () => {
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "https://worker.example", serviceToken: "secret" }),
      render: async (item) => ({ workerJobId: item.id, resultPaths: [] }),
      cleanup: async () => undefined
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const assets = [
      ...Array.from({ length: 5 }, (_, index) => ({ slot: "referenceImage" as const, kind: "image" as const, path: `/inputs/picture-${index + 1}.png`, filename: `picture-${index + 1}.png`, mimeType: "image/png" })),
      { slot: "referenceVideo" as const, kind: "video" as const, path: "/inputs/motion.mp4", filename: "motion.mp4", mimeType: "video/mp4" }
    ];
    const item = await service.create({ title: "Imported TrainScene", operation: "reference_mix", prompt: "Use <Video 1> and <Picture 1>–<Picture 5>.", duration: 15, aspectRatio: "adaptive", assets });

    const state = await service.getState();
    expect(state.items[0]).toMatchObject({ id: item.id, status: "ready", operation: "reference_mix", assets });
  });

  it("persists optional identity and provider-neutral camera controls", async () => {
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "https://worker.example", serviceToken: "secret" }),
      render: async (item) => ({ workerJobId: item.id, resultPaths: [] }),
      cleanup: async () => undefined
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const item = await service.create({
      title: "Identity orbit",
      operation: "reference_mix",
      prompt: "Preserve the performance",
      identityTransfer: { enabled: true, strength: 0.85 },
      cameraControlMode: "prompt",
      cameraPath: {
        schemaVersion: "1.0",
        interpolation: "smooth",
        loopClosure: "auto",
        startHold: 0.1,
        endHold: 0.2,
        subjectBox: { x: 0.2, y: 0.1, width: 0.5, height: 0.7 },
        keyframes: [
          { time: 0, orbit: { azimuth: 0, elevation: 0, distance: 1 } },
          { time: 1, orbit: { azimuth: 360, elevation: 0, distance: 1 } }
        ]
      }
    });

    const reloaded = new H3QueueService({ directory: service.directory, runtime });
    expect((await reloaded.getState()).items[0]).toMatchObject({
      id: item.id,
      identityTransfer: { enabled: true, strength: 0.85 },
      cameraControlMode: "prompt",
      cameraPath: { schemaVersion: "1.0", startHold: 0.1, endHold: 0.2, subjectBox: { width: 0.5 } }
    });
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

  it("cancels the active worker job and leaves later queue items ready", async () => {
    const events: string[] = [];
    let rejectRender: ((error: Error) => void) | undefined;
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "https://worker.example", serviceToken: "secret" }),
      render: async (item, _lease, _onProgress, onJobCreated) => {
        events.push(`render:${item.id}`);
        const cancelled = new Promise<never>((_resolve, reject) => { rejectRender = reject; });
        await onJobCreated?.(`worker-${item.id}`);
        return cancelled;
      },
      cancel: async (item) => {
        events.push(`cancel:${item.workerJobId}`);
        rejectRender?.(new Error("Worker job cancelled"));
      },
      cleanup: async () => { events.push("cleanup"); }
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const first = await service.create({ title: "Cancel me", operation: "text_to_video", prompt: "Scene 1" });
    const second = await service.create({ title: "Keep me", operation: "text_to_video", prompt: "Scene 2" });

    await service.start("saved_worker");
    await waitUntil(async () => (await service.getState()).items[0]?.workerJobId === `worker-${first.id}`);
    const cancelling = await service.cancelActive();
    const settled = await service.waitForSettled();

    expect(cancelling.status).toBe("cancelling");
    expect(events).toEqual([`render:${first.id}`, `cancel:worker-${first.id}`, "cleanup"]);
    expect(settled.session.status).toBe("cancelled");
    expect(settled.items[0]).toMatchObject({ status: "cancelled", workerJobId: `worker-${first.id}` });
    expect(settled.items[1]).toMatchObject({ id: second.id, status: "ready" });
  });

  it("renders only selected non-archived items and can restore archived jobs", async () => {
    const rendered: string[] = [];
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "https://worker.example", serviceToken: "secret" }),
      render: async (item) => {
        rendered.push(item.id);
        return { workerJobId: `worker-${item.id}`, resultPaths: [] };
      },
      cleanup: async () => undefined
    };
    const service = new H3QueueService({ directory: await queueDirectory(), runtime });
    const selected = await service.create({ title: "Selected", operation: "text_to_video", prompt: "Scene 1" });
    const skipped = await service.create({ title: "Skipped", operation: "text_to_video", prompt: "Scene 2" });
    const archived = await service.create({ title: "Archived", operation: "text_to_video", prompt: "Scene 3" });

    await service.setSelected(skipped.id, false);
    await service.archive(archived.id);
    await service.start("saved_worker");
    const settled = await service.waitForSettled();

    expect(rendered).toEqual([selected.id]);
    expect(settled.items.find((item) => item.id === skipped.id)).toMatchObject({ status: "ready", selectedForRun: false });
    expect(settled.items.find((item) => item.id === archived.id)).toMatchObject({ archivedAt: expect.any(String), selectedForRun: false });

    const restored = await service.restore(archived.id);
    expect(restored).toMatchObject({ selectedForRun: true });
    expect(restored?.archivedAt).toBeUndefined();
  });
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the queue state.");
}
