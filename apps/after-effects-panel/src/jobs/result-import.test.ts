import { describe, expect, it, vi } from "vitest";
import type { GenerationMetadata, PersistedJob } from "../types";
import { importDownloadedResult } from "./result-import";

const metadata = { jobId: "job_1" } as GenerationMetadata;
const baseJob: PersistedJob = {
  jobId: "job_1", serverUrl: "local", placeholder: { compositionId: 17, layerIndex: 4, footageItemId: 90, jobId: "job_1" }, outputPath: "C:\\output.mp4",
  createdAt: "now", status: "video_downloaded", modelId: "kling/v3", modelDisplayName: "Kling 3.0", provider: "polza", prompt: "move", params: {}, inputPaths: [], inputFramePath: "C:\\input.png", inputAssetId: "asset", sourceCompositionId: 17, sourceCompositionName: "Comp", sourceTime: 1, placeholderCreatedAt: "now", jobCreatedAt: "now"
};
const imported = { ok: true, resultPath: baseJob.outputPath, resultFileSize: 1024, importedItemId: 120, importedItemName: "Kling 3.0 · 2026-07-17 19-42-10", importedItemType: "FootageItem", importedItemSourceType: "FileSource", projectFolderId: 33, projectFolderName: "SnarkRoute Generations" };

describe("downloaded result import", () => {
  it("imports FileSource footage, replaces the located layer source, and writes metadata", async () => {
    const layerState = { index: 4, inPoint: 1, outPoint: 6, startTime: 1, stretch: 100, position: [960, 540], scale: [100, 100], rotation: 0, opacity: 100, effects: ["Glow"], masks: ["Mask 1"], blendMode: "NORMAL", parent: 7, markers: ["job_1"], comment: "job_1" };
    const before = structuredClone(layerState);
    const host = {
      importResultFootage: vi.fn(async () => imported),
      replacePlaceholderSource: vi.fn(async () => ({ ok: true, sourceReplaced: true, placeholderDeleted: false, placeholderCompositionId: 17, placeholderLayerIndex: 4, oldSourceId: 90, oldSourceType: "SolidSource", newSourceId: 120, newSourceType: "FileSource", solidRemoved: true })),
      writeGenerationMetadata: vi.fn(async () => { layerState.comment = "metadata"; })
    };
    const result = await importDownloadedResult(baseJob, metadata, { host, now: () => new Date(2026, 6, 17, 19, 42, 10) });
    expect(host.importResultFootage).toHaveBeenCalledWith(baseJob.outputPath, "Kling 3.0 · 2026-07-17 19-42-10");
    expect(host.replacePlaceholderSource).toHaveBeenCalledWith(baseJob.placeholder, 120, "Kling 3.0 · Generated");
    expect(result).toMatchObject({ status: "completed", importedFootage: { importedItemSourceType: "FileSource", projectFolderName: "SnarkRoute Generations" }, layerReplacement: { sourceReplaced: true, solidRemoved: true } });
    expect({ ...layerState, comment: before.comment }).toEqual(before);
  });

  it("keeps imported footage when the placeholder layer was deleted", async () => {
    const host = { importResultFootage: async () => imported, replacePlaceholderSource: async () => ({ ok: true, sourceReplaced: false, placeholderDeleted: true, placeholderCompositionId: 17, newSourceId: 120, newSourceType: "FileSource" }), writeGenerationMetadata: vi.fn() };
    const result = await importDownloadedResult(baseJob, metadata, { host });
    expect(result.status).toBe("completed_with_warning");
    expect(result.importedFootage?.importedItemId).toBe(120);
    expect(host.writeGenerationMetadata).not.toHaveBeenCalled();
  });

  it("imports the video even when placeholder creation originally failed", async () => {
    const importResultFootage = vi.fn(async () => imported);
    const host = { importResultFootage, replacePlaceholderSource: vi.fn(), writeGenerationMetadata: vi.fn() };
    const result = await importDownloadedResult({ ...baseJob, placeholder: undefined }, metadata, { host });
    expect(result).toMatchObject({ status: "completed_with_warning", importedFootage: { importedItemId: 120 } });
    expect(importResultFootage).toHaveBeenCalledOnce();
    expect(host.replacePlaceholderSource).not.toHaveBeenCalled();
  });

  it("retries only import/replacement without starting another generation", async () => {
    const importResultFootage = vi.fn(async () => imported);
    const replacePlaceholderSource = vi.fn()
      .mockResolvedValueOnce({ ok: false, sourceReplaced: false, placeholderDeleted: false, placeholderCompositionId: 17, replaceSourceError: "AE refused replaceSource" })
      .mockResolvedValueOnce({ ok: true, sourceReplaced: true, placeholderDeleted: false, placeholderCompositionId: 17, placeholderLayerIndex: 4, newSourceId: 120, newSourceType: "FileSource" });
    const host = { importResultFootage, replacePlaceholderSource, writeGenerationMetadata: vi.fn(async () => undefined) };
    const failed = await importDownloadedResult(baseJob, metadata, { host });
    expect(failed).toMatchObject({ status: "failed", outputPath: baseJob.outputPath, warning: "AE refused replaceSource" });
    const completed = await importDownloadedResult(failed, metadata, { host });
    expect(completed.status).toBe("completed");
    expect(importResultFootage).toHaveBeenCalledTimes(2);
    expect(replacePlaceholderSource).toHaveBeenCalledTimes(2);
  });
});
