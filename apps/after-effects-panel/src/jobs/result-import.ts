import type { AfterEffectsHostAdapter } from "../host/adapter";
import type { GenerationMetadata, PersistedJob } from "../types";

export type ResultImportPhase = "importing_result" | "organizing_project_items" | "replacing_layer_source" | "writing_metadata";

type ResultImportDependencies = {
  host: Pick<AfterEffectsHostAdapter, "importResultFootage" | "replacePlaceholderSource" | "writeGenerationMetadata">;
  onPhase?(phase: ResultImportPhase): void;
  onUpdate?(job: PersistedJob): void;
  now?(): Date;
};

export async function importDownloadedResult(job: PersistedJob, metadata: GenerationMetadata, dependencies: ResultImportDependencies): Promise<PersistedJob> {
  if (!job.outputPath) return failed(job, "Downloaded video path is missing.", dependencies);
  const placeholder = job.placeholder;

  let current = { ...job, metadata, warning: job.status === "failed" ? undefined : job.warning };
  try {
    dependencies.onPhase?.("importing_result");
    const imported = await dependencies.host.importResultFootage(current.outputPath, generatedItemName(current.modelDisplayName ?? current.modelId, dependencies.now?.() ?? new Date()));
    current = { ...current, importedFootage: imported };
    dependencies.onUpdate?.(current);
    if (!imported.ok || !imported.importedItemId) return failed(current, imported.importError || "After Effects did not import the downloaded video.", dependencies);
    if (!placeholder) return completedWarning(current, "Generated footage was imported, but no placeholder layer exists.", dependencies);

    dependencies.onPhase?.("organizing_project_items");
    dependencies.onPhase?.("replacing_layer_source");
    const replacement = await dependencies.host.replacePlaceholderSource(placeholder, imported.importedItemId, `${current.modelDisplayName ?? current.modelId} · Generated`);
    current = { ...current, layerReplacement: replacement };
    dependencies.onUpdate?.(current);
    if (!replacement.ok) return failed(current, replacement.replaceSourceError || "After Effects did not replace the placeholder source.", dependencies);
    if (replacement.placeholderDeleted) return completedWarning(current, "Placeholder layer was deleted; footage remains imported in SnarkRoute Generations.", dependencies);
    if (!replacement.sourceReplaced || replacement.newSourceId !== imported.importedItemId || replacement.newSourceType !== "FileSource") {
      return failed(current, "Layer source verification failed after replaceSource().", dependencies);
    }

    dependencies.onPhase?.("writing_metadata");
    const reference = { ...placeholder, layerIndex: replacement.placeholderLayerIndex ?? placeholder.layerIndex, footageItemId: imported.importedItemId, jobId: current.jobId };
    await dependencies.host.writeGenerationMetadata(reference, metadata);
    const completed: PersistedJob = { ...current, placeholder: reference, status: current.warning ? "completed_with_warning" : "completed" };
    dependencies.onUpdate?.(completed);
    return completed;
  } catch (error) {
    return failed(current, error instanceof Error ? error.message : String(error), dependencies);
  }
}

export function generatedItemName(modelDisplayName: string, date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${modelDisplayName} · ${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}-${part(date.getMinutes())}-${part(date.getSeconds())}`;
}

function failed(job: PersistedJob, warning: string, dependencies: ResultImportDependencies): PersistedJob {
  const failedJob = { ...job, status: "failed", warning };
  dependencies.onUpdate?.(failedJob);
  return failedJob;
}

function completedWarning(job: PersistedJob, warning: string, dependencies: ResultImportDependencies): PersistedJob {
  const completed = { ...job, status: "completed_with_warning", warning };
  dependencies.onUpdate?.(completed);
  return completed;
}
