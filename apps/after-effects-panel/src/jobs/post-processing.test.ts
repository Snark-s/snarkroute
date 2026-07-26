import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GenerationMetadata, PersistedJob } from "../types";
import type { ManifestNodeRuntime } from "./manifest-writer";
import { postProcessDownloadedJob, retryGenerationManifest } from "./post-processing";

const job: PersistedJob = { jobId: "job_1", serverUrl: "local", placeholder: { compositionId: 1, layerIndex: 1, footageItemId: 2, jobId: "job_1" }, outputPath: "C:\\ready.mp4", createdAt: "now", status: "video_downloaded", lastStage: "video_downloaded", modelId: "wan/2.5", provider: "polza", prompt: "move", params: {}, inputPaths: [], inputFramePath: "C:\\frame.png", inputAssetId: "asset", sourceCompositionId: 1, sourceCompositionName: "Comp", sourceTime: 0, placeholderCreatedAt: "now", jobCreatedAt: "now" };
const imported = { ok: true, resultPath: job.outputPath, resultFileSize: 100, importedItemId: 8, importedItemName: "WAN result", importedItemType: "FootageItem", importedItemSourceType: "FileSource" };

describe("independent result post-processing", () => {
  it("keeps a downloaded result as completed_with_warning and still imports/replaces when manifest writing fails", async () => {
    const phases: string[] = [];
    const host = { importResultFootage: vi.fn(async () => imported), replacePlaceholderSource: vi.fn(async () => ({ ok: true, sourceReplaced: true, placeholderDeleted: false, placeholderCompositionId: 1, placeholderLayerIndex: 1, newSourceId: 8, newSourceType: "FileSource" })), writeGenerationMetadata: vi.fn(async () => undefined) };
    const result = await postProcessDownloadedJob(job, metadata("C:\\blocked\\ready.mp4.json"), { host, runtime: failingRuntime(), onPhase: (phase) => phases.push(phase) });
    expect(result).toMatchObject({ status: "completed_with_warning", failedStage: "writing_manifest", outputPath: job.outputPath, importedFootage: { importedItemId: 8 }, layerReplacement: { sourceReplaced: true }, failure: { importedItemId: 8, layerSourceReplaced: true } });
    expect(phases).toEqual(["importing_video", "replacing_placeholder", "writing_ae_metadata", "writing_manifest"]);
    expect(host.importResultFootage).toHaveBeenCalledOnce();
    expect(host.replacePlaceholderSource).toHaveBeenCalledOnce();
  });

  it("Retry manifest only writes persisted metadata and never creates a generation job", async () => {
    const runtime = memoryRuntime();
    const createJob = vi.fn();
    const existing = { ...job, metadata: metadata("C:\\out\\ready.mp4.json"), status: "completed_with_warning", failedStage: "writing_manifest", warning: "Manifest failed" };
    const result = await retryGenerationManifest(existing, { runtime });
    expect(result.manifestDiagnostic?.ok).toBe(true);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("restores a persisted downloaded job through post-processing without provider generation", async () => {
    const updates: PersistedJob[] = [];
    const host = { importResultFootage: async () => imported, replacePlaceholderSource: async () => ({ ok: true, sourceReplaced: true, placeholderDeleted: false, placeholderCompositionId: 1, placeholderLayerIndex: 1, newSourceId: 8, newSourceType: "FileSource" }), writeGenerationMetadata: async () => undefined };
    const result = await postProcessDownloadedJob(structuredClone(job), metadata("C:\\out\\ready.mp4.json"), { host, runtime: memoryRuntime(), onUpdate: (updated) => updates.push(structuredClone(updated)) });
    expect(result.status).toBe("completed");
    expect(updates.some((updated) => updated.manifestDiagnostic?.ok)).toBe(true);
    expect(updates.at(-1)?.layerReplacement?.sourceReplaced).toBe(true);
  });
});

function metadata(manifestPath: string): GenerationMetadata { return { jobId: "job_1", modelId: "wan/2.5", provider: "polza", capability: "video.generate", prompt: "move", params: {}, inputs: [], createdAt: "now", estimatedCost: null, actualCost: null, manifestPath, inputFramePath: "C:\\frame.png", inputAssetId: "asset", sourceCompositionId: 1, sourceCompositionName: "Comp", sourceTime: 0, placeholderCreatedAt: "now", jobCreatedAt: "now" }; }
function failingRuntime(): ManifestNodeRuntime { const runtime = memoryRuntime(); runtime.fs.open = async () => { throw Object.assign(new Error("Access denied"), { code: "EACCES" }); }; return runtime; }
function memoryRuntime(): ManifestNodeRuntime {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return { path, env: {}, fs: {
    async mkdir(target) { directories.add(target); },
    async stat(target) { return { isDirectory: () => directories.has(target), size: files.get(target)?.length ?? 0 }; },
    async open(target) { let value = ""; return { async writeFile(data) { value = data; }, async close() { files.set(target, value); } }; },
    async rename(from, to) { files.set(to, files.get(from) ?? ""); files.delete(from); },
    async unlink(target) { files.delete(target); }
  } };
}
