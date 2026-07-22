import { maximumImageInputs, outputMediaTypeForOperation, requiredImageInputs } from "../api/catalog";
import type { SnarkRouteGatewayClient } from "../api/client";
import type { AfterEffectsHostAdapter } from "../host/adapter";
import type { CompositionSnapshot, FrameExportDiagnostic, GenerationInput, GenerationModel, GenerationOperation, PersistedJob } from "../types";

type PreparationDependencies = {
  host: Pick<AfterEffectsHostAdapter, "getActiveComposition" | "renderCurrentFrame" | "validateInputFile" | "createGenerationPlaceholder">;
  client: Pick<SnarkRouteGatewayClient, "importAsset" | "createJob">;
  readFileBase64(path: string): string;
  now?(): string;
  log?(label: string, details: Record<string, unknown>): void;
  onPhase?(phase: "exporting_current_frame" | "validating_input" | "uploading_asset" | "creating_job"): void;
  onJobPrepared?(job: PersistedJob): void;
  onExportDiagnostic?(diagnostic: FrameExportDiagnostic): void;
};

export type PrepareGenerationInput = { serverUrl: string; model: GenerationModel; operation?: GenerationOperation; prompt: string; parameters: Record<string, unknown>; imageSource?: "current-composition-frame" | "external-file"; externalImagePath?: string };

export async function prepareGeneration(input: PrepareGenerationInput, dependencies: PreparationDependencies): Promise<PersistedJob> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const operation = input.operation ?? "image-to-video";
  const source = await dependencies.host.getActiveComposition();
  const needsImage = operation.startsWith("image-to-") || ["image-editing", "inpainting", "outpainting", "image-upscale"].includes(operation);
  if (needsImage && input.imageSource !== "external-file" && !source) throw new Error("An active composition is required for Current composition frame.");

  const preparedInputs: GenerationInput[] = [];
  const assets: Array<{ id: string; path: string; input: Omit<GenerationInput, "assetId" | "localPath"> }> = [];
  let frame: FrameExportDiagnostic | undefined;
  if (needsImage) {
    const materialized = input.imageSource === "external-file"
      ? { path: input.externalImagePath ?? "", filename: fileName(input.externalImagePath ?? ""), sourceType: "external-file" as const }
      : await materializeCurrentFrame(source!, dependencies);
    frame = "diagnostic" in materialized ? materialized.diagnostic : undefined;
    dependencies.onPhase?.("validating_input");
    const validated = await dependencies.host.validateInputFile(materialized.path);
    assertValidInputFile(validated.path, validated.sizeBytes, validated.fileError);
    dependencies.onPhase?.("uploading_asset");
    const asset = await dependencies.client.importAsset(materialized.filename, dependencies.readFileBase64(validated.path));
    if (!asset.id || !asset.path) throw new Error("Uploaded input asset did not include an id and path.");
    const binding: GenerationInput = { kind: "image", role: "source", index: 0, sourceType: materialized.sourceType, compositionId: source?.id, compositionTime: source?.time, localPath: validated.path, assetId: asset.id };
    preparedInputs.push(binding);
    assets.push({ ...asset, input: { kind: binding.kind, role: binding.role, index: binding.index, sourceType: binding.sourceType, compositionId: binding.compositionId, compositionTime: binding.compositionTime } });
  }

  dependencies.onPhase?.("creating_job");
  const created = await dependencies.client.createJob({ model: input.model, operation, prompt: input.prompt, parameters: input.parameters, assets, asset: assets[0] });
  const outputMediaType = outputMediaTypeForOperation(operation);
  let pending: PersistedJob = {
    jobId: created.id, serverUrl: input.serverUrl, operation, capability: created.outputMediaType ? undefined : input.model.capabilities[0], outputMediaType,
    outputPath: "", outputs: [], createdAt: created.createdAt, status: created.status, lastStage: "creating_job", modelId: input.model.storedModelId,
    providerModelId: input.model.providerModelId, modelDisplayName: input.model.displayName, provider: input.model.provider, prompt: input.prompt, params: input.parameters,
    inputs: preparedInputs, inputPaths: preparedInputs.map((value) => value.localPath), inputFramePath: preparedInputs[0]?.localPath, inputAssetId: preparedInputs[0]?.assetId,
    sourceCompositionId: source?.id, sourceCompositionName: source?.name, sourceTime: source?.time, placeholderCreatedAt: null, jobCreatedAt: created.createdAt, inputFrameExport: frame,
    inputModelContract: { requiredImageInputs: requiredImageInputs(input.model), maximumImageInputs: maximumImageInputs(input.model), optionalImageInputs: Math.max(0, maximumImageInputs(input.model) - requiredImageInputs(input.model)), inputRoles: input.model.inputRoles ?? [], imagesSupplied: preparedInputs.length }
  };
  dependencies.onJobPrepared?.(pending);

  if (!source) return pending;
  try {
    const duration = outputMediaType === "image" ? Math.max(1 / source.frameRate, source.duration - source.time) : Number(input.parameters.duration ?? 5);
    const placeholder = await dependencies.host.createGenerationPlaceholder({ jobId: created.id, name: `Generating · ${input.model.displayName}`, duration, compositionId: source.id, sourceTime: source.time, width: source.width, height: source.height, frameRate: source.frameRate, pixelAspect: source.pixelAspect, mediaKind: outputMediaType });
    pending = { ...pending, placeholder, placeholderCreatedAt: now() };
  } catch (error) {
    pending = { ...pending, warning: `Provider job ${created.id} was created, but the After Effects placeholder could not be created: ${error instanceof Error ? error.message : String(error)}` };
  }
  dependencies.onJobPrepared?.(pending);
  return pending;
}

async function materializeCurrentFrame(source: CompositionSnapshot, dependencies: PreparationDependencies) {
  dependencies.onPhase?.("exporting_current_frame");
  dependencies.onExportDiagnostic?.({ stage: "exporting_current_frame", exportMethod: "saveFrameToPng", path: "waiting for After Effects…", exists: false, size: 0, waitedMs: 0, attempts: 0, fileError: "", fallbackAttempted: false });
  const diagnostic = await dependencies.host.renderCurrentFrame(source);
  dependencies.onExportDiagnostic?.(diagnostic);
  if (!diagnostic.ok) throw currentFrameExportError(diagnostic.path, `${diagnostic.fileError || "Timed out waiting for PNG data."} (attempts=${diagnostic.attempts}, waitedMs=${diagnostic.waitedMs}, size=${diagnostic.size})`);
  return { path: diagnostic.path, filename: diagnostic.filename, sourceType: "current-composition-frame" as const, diagnostic };
}

export function inputDiagnostic(source: CompositionSnapshot, path: string, sizeBytes: number, assetId: string, model: GenerationModel) { return { compositionName: source.name, compositionId: source.id, currentTime: source.time, exportedPngPath: path, pngFileSize: sizeBytes, assetId, modelId: model.storedModelId, providerModelId: model.providerModelId, requestImageField: "inputs[0]" }; }
function assertValidInputFile(path: string, sizeBytes: number, fileError: string): void { const absolute = /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\//.test(path); if (!absolute || sizeBytes <= 0 || fileError) throw currentFrameExportError(path, fileError || (!absolute ? "Input path is not absolute." : "File is empty.")); }
function currentFrameExportError(path: string, fileError: string): Error { return new Error(`Current frame export failed\nPath: ${path || "unknown"}\nFile.error: ${fileError || "unknown"}`); }
function fileName(path: string) { return path.split(/[\\/]/).pop() || "input.png"; }
