import { describe, expect, it, vi } from "vitest";
import type { CompositionSnapshot, VideoModel } from "../types";
import { prepareGeneration } from "./generation";

const source: CompositionSnapshot = { id: 17, name: "Hero comp", time: 2.5, width: 1920, height: 1080, frameRate: 25, duration: 30, pixelAspect: 1 };
const model: VideoModel = { id: "polza:wan/2.6", provider: "polza", providerModelId: "wan/2.6", displayName: "Wan 2.6", inputTypes: ["image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: [], availability: { status: "available" }, parameters: [], nodeType: "polza.video.generate", storedModelId: "wan/2.6" };

describe("generation input preparation", () => {
  it("orders render, validation, upload, job creation, then placeholder", async () => {
    const calls: string[] = [];
    const persisted: Array<{ placeholder?: unknown; warning?: string }> = [];
    let placeholderExists = false;
    const pending = await prepareGeneration({ serverUrl: "http://127.0.0.1:4317", model, prompt: "move", parameters: { duration: 5 } }, {
      host: {
        getActiveComposition: async () => { calls.push("getActiveComposition"); return source; },
        renderCurrentFrame: async () => { calls.push("renderCurrentFrame"); expect(placeholderExists).toBe(false); return rendered("C:\\Temp\\input.png"); },
        validateInputFile: async (path) => { calls.push("validateInputFile"); return { path, sizeBytes: 128, fileError: "" }; },
        createGenerationPlaceholder: async () => { calls.push("createPlaceholder"); placeholderExists = true; return { compositionId: 17, layerIndex: 1, footageItemId: 90 }; }
      },
      client: {
        importAsset: async () => { calls.push("uploadAsset"); return { id: "asset_input", path: "C:\\server\\asset_input.png" }; },
        createJob: async (request) => { calls.push("createJob"); expect(request.asset.id).toBe("asset_input"); return { id: "job_1", status: "queued", createdAt: "job-time", updatedAt: "job-time" }; }
      },
      readFileBase64: () => "cG5n",
      now: () => "placeholder-time",
      log: () => undefined,
      onJobPrepared: (job) => persisted.push(job)
    });

    expect(calls).toEqual(["getActiveComposition", "renderCurrentFrame", "validateInputFile", "uploadAsset", "createJob", "createPlaceholder"]);
    expect(persisted[0].placeholder).toBeUndefined();
    expect(persisted[1].placeholder).toBeDefined();
    expect(pending).toMatchObject({ inputFramePath: "C:\\Temp\\input.png", inputAssetId: "asset_input", jobCreatedAt: "job-time", placeholderCreatedAt: "placeholder-time" });
  });

  it("blocks upload, provider job, and placeholder when the PNG is empty", async () => {
    const importAsset = vi.fn();
    const createJob = vi.fn();
    const createPlaceholder = vi.fn();
    await expect(prepareGeneration({ serverUrl: "local", model, prompt: "move", parameters: {} }, {
      host: { getActiveComposition: async () => source, renderCurrentFrame: async () => rendered("C:\\Temp\\empty.png"), validateInputFile: async (path) => ({ path, sizeBytes: 0, fileError: "" }), createGenerationPlaceholder: createPlaceholder },
      client: { importAsset, createJob },
      readFileBase64: () => "",
      log: () => undefined
    })).rejects.toThrow(/Current frame export failed[\s\S]*C:\\Temp\\empty\.png[\s\S]*File is empty/);
    expect(importAsset).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    expect(createPlaceholder).not.toHaveBeenCalled();
  });

  it("blocks validation, upload, provider job, and placeholder after export timeout", async () => {
    const validateInputFile = vi.fn();
    const importAsset = vi.fn();
    const createJob = vi.fn();
    const createPlaceholder = vi.fn();
    await expect(prepareGeneration({ serverUrl: "local", model, prompt: "move", parameters: {} }, {
      host: { getActiveComposition: async () => source, renderCurrentFrame: async () => ({ ...rendered("C:\\Temp\\timeout.png"), ok: false, exists: false, size: 0, waitedMs: 10000, attempts: 68, fileError: "Timed out waiting for saveFrameToPng." }), validateInputFile, createGenerationPlaceholder: createPlaceholder },
      client: { importAsset, createJob }, readFileBase64: () => "", log: () => undefined
    })).rejects.toThrow(/Current frame export failed[\s\S]*waitedMs=10000/);
    expect(validateInputFile).not.toHaveBeenCalled();
    expect(importAsset).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    expect(createPlaceholder).not.toHaveBeenCalled();
  });

  it("continues after job creation when placeholder creation fails", async () => {
    const pending = await prepareGeneration({ serverUrl: "local", model, prompt: "move", parameters: {} }, {
      host: { getActiveComposition: async () => source, renderCurrentFrame: async () => rendered("C:\\Temp\\input.png", 1), validateInputFile: async (path) => ({ path, sizeBytes: 1, fileError: "" }), createGenerationPlaceholder: async () => { throw new Error("AE refused solid"); } },
      client: { importAsset: async () => ({ id: "asset_input", path: "C:\\server\\input.png" }), createJob: async () => ({ id: "job_1", status: "queued", createdAt: "job-time", updatedAt: "job-time" }) },
      readFileBase64: () => "cA==",
      log: () => undefined
    });
    expect(pending.placeholder).toBeUndefined();
    expect(pending.warning).toContain("AE refused solid");
  });
});

function rendered(path: string, size = 128) { return { ok: true, stage: "exporting_current_frame" as const, exportMethod: "saveFrameToPng" as const, path, filename: path.split("\\").pop() ?? "input.png", exists: true, size, waitedMs: 300, attempts: 3, fileError: "", fallbackAttempted: false }; }
