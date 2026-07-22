import type { AfterEffectsHostAdapter } from "../host/adapter";
import type { GenerationMetadata, GenerationOutput, ImportedFootageDiagnostic, PersistedJob } from "../types";

export type ResultImportPhase = "importing_images" | "importing_video" | "replacing_placeholder" | "organizing_project_items" | "writing_ae_metadata";
type ResultImportDependencies = { host: Pick<AfterEffectsHostAdapter, "importResultFootage" | "replacePlaceholderSource" | "writeGenerationMetadata">; onPhase?(phase: ResultImportPhase): void; onUpdate?(job: PersistedJob): void; now?(): Date };

export async function importDownloadedResult(job: PersistedJob, metadata: GenerationMetadata, dependencies: ResultImportDependencies): Promise<PersistedJob> {
  const mediaKind = job.outputMediaType ?? metadata.outputMediaType ?? "video";
  const outputs = downloadableOutputs(job, mediaKind);
  if (!outputs.length) return warning(job, mediaKind === "image" ? "importing_images" : "importing_video", "Downloaded result path is missing.", dependencies);
  let current: PersistedJob = job.failedStage && job.failedStage !== "writing_manifest" ? { ...job, metadata, warning: undefined, failedStage: undefined, failure: undefined } : { ...job, metadata };
  try {
    dependencies.onPhase?.(mediaKind === "image" ? "importing_images" : "importing_video");
    const imported: ImportedFootageDiagnostic[] = [];
    for (const output of outputs) {
      const suffix = outputs.length > 1 ? ` · ${output.index + 1}` : "";
      imported.push(await dependencies.host.importResultFootage(output.path!, `${generatedItemName(current.modelDisplayName ?? current.modelId, dependencies.now?.() ?? new Date())}${suffix}`, mediaKind));
    }
    const failed = imported.find((value) => !value.ok || !value.importedItemId);
    current = { ...current, importedOutputs: imported, importedFootage: imported[0] };
    dependencies.onUpdate?.(current);
    if (failed) return warning(current, mediaKind === "image" ? "importing_images" : "importing_video", failed.importError || "After Effects did not import every downloaded result.", dependencies);

    const importedIds = imported.map((value) => value.importedItemId!);
    let replacement = current.layerReplacement;
    if (current.placeholder) {
      dependencies.onPhase?.("replacing_placeholder");
      replacement = await dependencies.host.replacePlaceholderSource(current.placeholder, importedIds[0], `${current.modelDisplayName ?? current.modelId} · Generated`);
      current = { ...current, layerReplacement: replacement };
      dependencies.onUpdate?.(current);
      if (!replacement.ok || (!replacement.placeholderDeleted && (!replacement.sourceReplaced || replacement.newSourceId !== importedIds[0] || replacement.newSourceType !== "FileSource"))) return warning(current, "replacing_placeholder", replacement.replaceSourceError || "Layer source verification failed after replaceSource().", dependencies);
      if (replacement.placeholderDeleted) return warning(current, "replacing_placeholder", "Placeholder layer was deleted; generated footage remains imported in the Project panel.", dependencies);
    }

    const completedOutputs = outputs.map((output, index): GenerationOutput => ({ ...output, importedItemId: importedIds[index], usedAsPlaceholderReplacement: index === 0 && Boolean(replacement?.sourceReplaced) }));
    const completedMetadata: GenerationMetadata = { ...metadata, outputs: completedOutputs, importedItemIds: importedIds, primaryOutputIndex: 0, completedAt: new Date().toISOString(), projectFolder: mediaKind === "image" ? "SnarkRoute Generations/Images" : "SnarkRoute Generations/Videos" };
    if (current.placeholder && replacement?.sourceReplaced) {
      dependencies.onPhase?.("writing_ae_metadata");
      const reference = { ...current.placeholder, layerIndex: replacement.placeholderLayerIndex ?? current.placeholder.layerIndex, footageItemId: importedIds[0], jobId: current.jobId };
      await dependencies.host.writeGenerationMetadata(reference, completedMetadata);
      current = { ...current, placeholder: reference };
    }
    const completed: PersistedJob = { ...current, outputs: completedOutputs, primaryOutputIndex: 0, metadata: completedMetadata, status: current.warning ? "completed_with_warning" : "completed", lastStage: current.warning ? "completed_with_warning" : "completed" };
    dependencies.onUpdate?.(completed);
    return completed;
  } catch (error) { return warning(current, "writing_ae_metadata", error instanceof Error ? error.message : String(error), dependencies); }
}

export function generatedItemName(modelDisplayName: string, date: Date): string { const part = (value: number) => String(value).padStart(2, "0"); return `${modelDisplayName} · ${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}-${part(date.getMinutes())}-${part(date.getSeconds())}`; }
function downloadableOutputs(job: PersistedJob, kind: "image" | "video" | "audio"): GenerationOutput[] { return job.outputs?.filter((output) => output.path) ?? (job.outputPath ? [{ kind, role: "primary", index: 0, path: job.outputPath, filename: fileName(job.outputPath), mimeType: kind === "image" ? "image/png" : "video/mp4" }] : []); }
function warning(job: PersistedJob, failedStage: string, text: string, dependencies: ResultImportDependencies): PersistedJob { const completed: PersistedJob = { ...job, status: "completed_with_warning", lastStage: "completed_with_warning", failedStage, warning: text, failure: { failedStage, message: text, technicalDetails: text, outputPath: job.outputPath, manifestPath: job.metadata?.manifestPath ?? "", jobId: job.jobId, providerJobId: job.jobId, importedItemId: job.importedFootage?.importedItemId, layerSourceReplaced: Boolean(job.layerReplacement?.sourceReplaced) } }; dependencies.onUpdate?.(completed); return completed; }
function fileName(path: string) { return path.split(/[\\/]/).pop() || "result"; }
