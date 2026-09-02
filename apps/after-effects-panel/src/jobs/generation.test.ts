import { describe, expect, it, vi } from "vitest";
import type { CompositionSnapshot, VideoModel } from "../types";
import { prepareGeneration } from "./generation";

const source: CompositionSnapshot = { id: 17, name: "Hero comp", time: 2.5, width: 1920, height: 1080, frameRate: 25, duration: 30, pixelAspect: 1 };
const model: VideoModel = { id: "polza:wan/2.6", provider: "polza", providerModelId: "wan/2.6", displayName: "Wan 2.6", inputTypes: ["image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: [], availability: { status: "available" }, parameters: [], nodeType: "polza.video.generate", storedModelId: "wan/2.6" };

describe("generation input preparation", () => {
  it("uploads every filled slot and preserves kind, role, and index in the job request", async () => {
    const multiModel: VideoModel = { ...model, inputTypes: ["image", "audio", "video"], inputContract: { inputs: [{ kind: "image", minItems: 2, maxItems: 3 }, { kind: "audio", minItems: 1, maxItems: 1 }, { kind: "video", minItems: 1, maxItems: 1 }] } };
    const createJob = vi.fn(async (_request: { assets?: unknown[] }) => ({ id: "job_multi", status: "queued" as const, createdAt: "now", updatedAt: "now" }));
    const slots = [
      { slotId: "frames", kind: "image" as const, role: "reference", label: "References", minItems: 2, maxItems: 3, required: true, ordered: true, items: [external("image", "C:\\one.png"), external("image", "C:\\two.png")] },
      { slotId: "audio", kind: "audio" as const, role: "audio", label: "Audio", minItems: 1, maxItems: 1, required: true, ordered: true, items: [external("audio", "C:\\sound.wav")] },
      { slotId: "video", kind: "video" as const, role: "sourceVideo", label: "Video", minItems: 1, maxItems: 1, required: true, ordered: true, items: [external("video", "C:\\motion.mp4")] }
    ];
    await prepareGeneration({ serverUrl: "local", model: multiModel, prompt: "move", parameters: {}, inputSlots: slots }, { host: { getActiveComposition: async () => null, renderCurrentFrame: vi.fn(), validateInputFile: async (path) => ({ path, sizeBytes: 10, fileError: "" }), createGenerationPlaceholder: vi.fn() }, client: { importAsset: async (name, _data, kind) => ({ id: `asset_${kind}_${name}`, path: `C:\\server\\${name}` }), createJob }, readFileBase64: () => "ZGF0YQ==" });
    expect(createJob.mock.calls[0]![0].assets).toEqual([
      expect.objectContaining({ id: "asset_image_one.png", input: expect.objectContaining({ kind: "image", role: "reference", index: 0 }) }),
      expect.objectContaining({ id: "asset_image_two.png", input: expect.objectContaining({ kind: "image", role: "reference", index: 1 }) }),
      expect.objectContaining({ id: "asset_audio_sound.wav", input: expect.objectContaining({ kind: "audio", role: "audio", index: 0 }) }),
      expect.objectContaining({ id: "asset_video_motion.mp4", input: expect.objectContaining({ kind: "video", role: "sourceVideo", index: 0 }) })
    ]);
  });
  it("orders render, validation, upload, job creation, then placeholder", async () => {
    const calls: string[] = [];
    const phases: string[] = [];
    const persisted: Array<{ placeholder?: unknown; warning?: string }> = [];
    let placeholderExists = false;
    const pending = await prepareGeneration({ serverUrl: "http://127.0.0.1:4317", model, prompt: "move", parameters: { duration: 5 } }, {
      host: {
        getActiveComposition: async () => { calls.push("getActiveComposition"); return source; },
        renderCurrentFrame: async () => { calls.push("renderCurrentFrame"); expect(placeholderExists).toBe(false); return rendered("C:\\Temp\\input.png"); },
        validateInputFile: async (path) => { calls.push("validateInputFile"); return { path, sizeBytes: 128, fileError: "" }; },
        createGenerationPlaceholder: async (spec) => { calls.push("createPlaceholder"); expect(spec).toMatchObject({ jobId: "job_1", modelId: "wan/2.6", displayName: "Wan 2.6", name: "Generating · Wan 2.6", previewPath: "C:\\Temp\\input.png", previewTemporary: true }); placeholderExists = true; return { compositionId: 17, layerIndex: 1, footageItemId: 90, jobId: spec.jobId, previewPath: spec.previewPath, previewTemporary: spec.previewTemporary, placeholderKind: "source-preview", overlayCreated: true }; }
      },
      client: {
        importAsset: async () => { calls.push("uploadAsset"); return { id: "asset_input", path: "C:\\server\\asset_input.png" }; },
        createJob: async (request) => { calls.push("createJob"); expect(request.assets?.[0].id).toBe("asset_input"); expect(JSON.stringify(request)).not.toContain("Generating"); return { id: "job_1", status: "queued", createdAt: "job-time", updatedAt: "job-time" }; }
      },
      readFileBase64: () => "cG5n",
      now: () => "placeholder-time",
      log: () => undefined,
      onJobPrepared: (job) => persisted.push(job),
      onPhase: (phase) => phases.push(phase)
    });

    expect(calls).toEqual(["getActiveComposition", "renderCurrentFrame", "validateInputFile", "uploadAsset", "createJob", "createPlaceholder"]);
    expect(phases).toEqual(["exporting_current_frame", "validating_input", "uploading_asset", "creating_job"]);
    expect(persisted[0].placeholder).toBeUndefined();
    expect(persisted[1].placeholder).toBeDefined();
    expect(pending).toMatchObject({ inputFramePath: "C:\\Temp\\input.png", inputAssetId: "asset_input", jobCreatedAt: "job-time", placeholderCreatedAt: "placeholder-time", inputModelContract: { requiredImageInputs: 0, maximumImageInputs: 1, imagesSupplied: 1 }, placeholder: { jobId: "job_1", previewPath: "C:\\Temp\\input.png", previewTemporary: true, placeholderKind: "source-preview", overlayCreated: true } });
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

  it("keeps the provider job when the overlay cannot be created", async () => {
    const pending = await prepareGeneration({ serverUrl: "local", model, prompt: "move", parameters: {} }, {
      host: { getActiveComposition: async () => source, renderCurrentFrame: async () => rendered("C:\\Temp\\input.png", 1), validateInputFile: async (path) => ({ path, sizeBytes: 1, fileError: "" }), createGenerationPlaceholder: async (spec) => ({ compositionId: source.id, layerIndex: 1, footageItemId: 90, jobId: spec.jobId, placeholderKind: "source-preview", overlayCreated: false, overlayError: "Text layers are unavailable" }) },
      client: { importAsset: async () => ({ id: "asset_input", path: "C:\\server\\input.png" }), createJob: async () => ({ id: "job_1", status: "queued", createdAt: "job-time", updatedAt: "job-time" }) },
      readFileBase64: () => "cA=="
    });
    expect(pending).toMatchObject({ jobId: "job_1", placeholder: { overlayCreated: false }, status: "queued" });
    expect(pending.warning).toContain("Generation overlay could not be created");
  });

  it("uses a Solid fallback only when no visual input is available", async () => {
    const textModel: VideoModel = { ...model, inputTypes: ["text"], inputContract: { inputs: [] } };
    const createGenerationPlaceholder = vi.fn(async (spec) => ({ compositionId: source.id, layerIndex: 1, footageItemId: 90, jobId: spec.jobId, placeholderKind: "solid-fallback" as const, overlayCreated: true }));
    const pending = await prepareGeneration({ serverUrl: "local", model: textModel, operation: "text-to-video", prompt: "move", parameters: {} }, {
      host: { getActiveComposition: async () => source, renderCurrentFrame: vi.fn(), validateInputFile: vi.fn(), createGenerationPlaceholder },
      client: { importAsset: vi.fn(), createJob: async () => ({ id: "job_text", status: "queued", createdAt: "job-time", updatedAt: "job-time" }) },
      readFileBase64: vi.fn()
    });
    expect(createGenerationPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job_text", previewPath: undefined, previewKind: undefined }));
    expect(pending.placeholder?.placeholderKind).toBe("solid-fallback");
  });
});

function rendered(path: string, size = 128) { return { ok: true, stage: "exporting_current_frame" as const, exportMethod: "saveFrameToPng" as const, path, filename: path.split("\\").pop() ?? "input.png", exists: true, size, waitedMs: 300, attempts: 3, fileError: "", fallbackAttempted: false }; }
function external(kind: "image" | "audio" | "video", path: string) { return { sourceType: "external-file" as const, kind, path, filename: path.split("\\").pop(), validationState: "ready" as const }; }

describe("image generation preparation", () => {
  const imageModel: VideoModel = { ...model, id: "image", providerModelId: "gpt-image", displayName: "Image", inputTypes: ["text", "image"], outputTypes: ["image"], capabilities: ["image.generate"], roles: ["generator", "editor"], nodeType: "polza.image.generate", storedModelId: "gpt-image" };
  it("allows text-to-image without an active composition and creates no placeholder", async () => { const placeholder = vi.fn(); const pending = await prepareGeneration({ serverUrl: "local", model: imageModel, operation: "text-to-image", prompt: "draw", parameters: {} }, { host: { getActiveComposition: async () => null, renderCurrentFrame: vi.fn(), validateInputFile: vi.fn(), createGenerationPlaceholder: placeholder }, client: { importAsset: vi.fn(), createJob: async () => ({ id: "job_image", status: "queued", createdAt: "now", updatedAt: "now", outputMediaType: "image" }) }, readFileBase64: vi.fn() }); expect(pending).toMatchObject({ outputMediaType: "image", inputs: [] }); expect(pending.placeholder).toBeUndefined(); expect(placeholder).not.toHaveBeenCalled(); });
  it("uses an external image directly without AE frame rendering or an active composition", async () => { const render = vi.fn(); const pending = await prepareGeneration({ serverUrl: "local", model: imageModel, operation: "image-to-image", prompt: "edit", parameters: {}, imageSource: "external-file", externalImagePath: "C:\\source.png" }, { host: { getActiveComposition: async () => null, renderCurrentFrame: render, validateInputFile: async (path) => ({ path, sizeBytes: 10, fileError: "" }), createGenerationPlaceholder: vi.fn() }, client: { importAsset: async () => ({ id: "asset", path: "C:\\server\\source.png" }), createJob: async () => ({ id: "job_edit", status: "queued", createdAt: "now", updatedAt: "now", outputMediaType: "image" }) }, readFileBase64: () => "cG5n" }); expect(render).not.toHaveBeenCalled(); expect(pending.inputs?.[0]).toMatchObject({ sourceType: "external-file", localPath: "C:\\source.png", assetId: "asset" }); });
});
