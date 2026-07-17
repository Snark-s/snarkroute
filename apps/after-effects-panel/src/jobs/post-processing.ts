import type { GenerationMetadata, PersistedJob } from "../types";
import { manifestFailureText, writeGenerationManifest, type ManifestNodeRuntime } from "./manifest-writer";
import { importDownloadedResult } from "./result-import";
import type { AfterEffectsHostAdapter } from "../host/adapter";

type Dependencies = {
  host: Pick<AfterEffectsHostAdapter, "importResultFootage" | "replacePlaceholderSource" | "writeGenerationMetadata">;
  runtime?: ManifestNodeRuntime;
  onPhase?(phase: "writing_manifest" | "importing_result" | "replacing_layer_source" | "writing_ae_metadata"): void;
  onUpdate?(job: PersistedJob): void;
};

export async function postProcessDownloadedJob(job: PersistedJob, metadata: GenerationMetadata, dependencies: Dependencies): Promise<PersistedJob> {
  dependencies.onPhase?.("writing_manifest");
  const manifestDiagnostic = await writeGenerationManifest(metadata, dependencies.runtime);
  let current: PersistedJob = { ...job, metadata, manifestDiagnostic, lastStage: "writing_manifest" };
  if (!manifestDiagnostic.ok) {
    const technicalDetails = manifestFailureText(manifestDiagnostic);
    current = { ...current, status: "completed_with_warning", failedStage: "writing_manifest", warning: "Video generated and downloaded successfully. Manifest could not be written.", failure: { failedStage: "writing_manifest", message: "Manifest write failed", technicalDetails, outputPath: job.outputPath, manifestPath: metadata.manifestPath, jobId: job.jobId, providerJobId: job.jobId, importedItemId: job.importedFootage?.importedItemId, layerSourceReplaced: Boolean(job.layerReplacement?.sourceReplaced) } };
  }
  dependencies.onUpdate?.(current);
  return importDownloadedResult(current, metadata, { host: dependencies.host, onPhase: dependencies.onPhase, onUpdate: dependencies.onUpdate });
}

export async function retryGenerationManifest(job: PersistedJob, dependencies: Pick<Dependencies, "runtime" | "onPhase" | "onUpdate">): Promise<PersistedJob> {
  if (!job.metadata) throw new Error("Generation metadata is unavailable for Retry manifest.");
  dependencies.onPhase?.("writing_manifest");
  const manifestDiagnostic = await writeGenerationManifest(job.metadata, dependencies.runtime);
  const warning = manifestDiagnostic.ok && job.failedStage === "writing_manifest" ? undefined : job.warning;
  const updated: PersistedJob = manifestDiagnostic.ok
    ? { ...job, manifestDiagnostic, warning, failedStage: undefined, failure: undefined, status: job.layerReplacement?.sourceReplaced ? "completed" : "video_downloaded", lastStage: job.layerReplacement?.sourceReplaced ? "completed" : "video_downloaded" }
    : { ...job, manifestDiagnostic, status: "completed_with_warning", lastStage: "completed_with_warning", failedStage: "writing_manifest", warning: "Video generated and downloaded successfully. Manifest could not be written.", failure: { failedStage: "writing_manifest", message: "Manifest write failed", technicalDetails: manifestFailureText(manifestDiagnostic), outputPath: job.outputPath, manifestPath: job.metadata.manifestPath, jobId: job.jobId, providerJobId: job.jobId, importedItemId: job.importedFootage?.importedItemId, layerSourceReplaced: Boolean(job.layerReplacement?.sourceReplaced) } };
  dependencies.onUpdate?.(updated);
  return updated;
}
