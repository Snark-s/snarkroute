import { maximumImageInputs, outputMediaTypeForOperation, requiredImageInputs } from "../api/catalog";
import { inputValidationErrors } from "../inputs/contracts";
import type { SnarkRouteGatewayClient } from "../api/client";
import type { AfterEffectsHostAdapter } from "../host/adapter";
import type { AeInputSource, CompositionSnapshot, FrameExportDiagnostic, GenerationInput, GenerationModel, GenerationOperation, InputSlotState, MediaKind, PersistedJob } from "../types";

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

export type PrepareGenerationInput = { serverUrl: string; model: GenerationModel; operation?: GenerationOperation; prompt: string; parameters: Record<string, unknown>; inputSlots?: InputSlotState[]; imageSource?: "current-composition-frame" | "external-file"; externalImagePath?: string };

export async function prepareGeneration(input: PrepareGenerationInput, dependencies: PreparationDependencies): Promise<PersistedJob> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const operation = input.operation ?? "image-to-video";
  const source = await dependencies.host.getActiveComposition();
  const slots = input.inputSlots ?? legacyInputSlots(input);
  const inputErrors = inputValidationErrors(input.model, slots);
  if (inputErrors.length) throw new Error(inputErrors.join(" "));

  const preparedInputs: GenerationInput[] = [];
  const assets: Array<{ id: string; path: string; input: Omit<GenerationInput, "assetId" | "localPath"> }> = [];
  let frame: FrameExportDiagnostic | undefined;
  for (const slot of slots) {
    for (let index = 0; index < slot.items.length; index += 1) {
      const selected = slot.items[index];
      if (!selected) continue;
      const materialized = selected.sourceType === "current-composition-frame"
        ? await materializeCurrentFrame(source ?? requiredComposition(), dependencies)
        : { path: selected.path ?? "", filename: selected.filename ?? fileName(selected.path ?? ""), sourceType: selected.sourceType, selected };
      if ("diagnostic" in materialized && !frame) frame = materialized.diagnostic;
      dependencies.onPhase?.("validating_input");
      const validated = await dependencies.host.validateInputFile(materialized.path);
      assertValidInputFile(validated.path, validated.sizeBytes, validated.fileError);
      dependencies.onPhase?.("uploading_asset");
      const asset = await dependencies.client.importAsset(materialized.filename, dependencies.readFileBase64(validated.path), slot.kind);
      if (!asset.id || !asset.path) throw new Error("Uploaded input asset did not include an id and path.");
      const descriptor = "selected" in materialized ? materialized.selected : selected;
      const binding: GenerationInput = { kind: slot.kind, role: slot.role, index, sourceType: materialized.sourceType, compositionId: descriptor.compositionId ?? source?.id, compositionName: descriptor.compositionName ?? source?.name, compositionTime: descriptor.compositionTime ?? source?.time, localPath: validated.path, mimeType: descriptor.mimeType ?? mimeType(validated.path, slot.kind), fileSize: validated.sizeBytes, assetId: asset.id };
      preparedInputs.push(binding);
      assets.push({ ...asset, input: { kind: binding.kind, role: binding.role, index: binding.index, sourceType: binding.sourceType, compositionId: binding.compositionId, compositionName: binding.compositionName, compositionTime: binding.compositionTime, mimeType: binding.mimeType, fileSize: binding.fileSize } });
    }
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
    const previewInput = preparedInputs.find((value) => value.kind === "image") ?? preparedInputs.find((value) => value.kind === "video");
    const placeholder = await dependencies.host.createGenerationPlaceholder({ jobId: created.id, modelId: input.model.storedModelId, displayName: input.model.displayName, name: `Generating · ${input.model.displayName}`, duration, compositionId: source.id, sourceTime: source.time, width: source.width, height: source.height, frameRate: source.frameRate, pixelAspect: source.pixelAspect, mediaKind: outputMediaType, previewPath: previewInput?.localPath, previewKind: previewInput?.kind, previewTemporary: previewInput?.sourceType === "current-composition-frame" || previewInput?.sourceType === "captured-composition-frame" });
    const visualWarnings = [placeholder.previewError ? `First-frame placeholder import failed; a Solid fallback was used: ${placeholder.previewError}` : "", placeholder.overlayError ? `Generation overlay could not be created: ${placeholder.overlayError}` : ""].filter(Boolean);
    pending = { ...pending, placeholder, placeholderCreatedAt: now(), warning: visualWarnings.length ? visualWarnings.join(" ") : pending.warning };
  } catch (error) {
    pending = { ...pending, warning: `Provider job ${created.id} was created, but the After Effects placeholder could not be created: ${error instanceof Error ? error.message : String(error)}` };
  }
  dependencies.onJobPrepared?.(pending);
  return pending;
}

function legacyInputSlots(input: PrepareGenerationInput): InputSlotState[] {
  const needsImage = (input.operation ?? "image-to-video").startsWith("image-to-") || ["image-editing", "inpainting", "outpainting", "image-upscale"].includes(input.operation ?? "");
  if (!needsImage) return [];
  const item: AeInputSource = input.imageSource === "external-file"
    ? { sourceType: "external-file", kind: "image", path: input.externalImagePath, filename: fileName(input.externalImagePath ?? ""), validationState: "ready" }
    : { sourceType: "current-composition-frame", kind: "image", validationState: "ready" };
  return [{ slotId: "legacy-image", kind: "image", role: "sourceImage", label: "Source image", minItems: 1, maxItems: 1, required: true, ordered: true, items: [item] }];
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
function requiredComposition(): never { throw new Error("An active composition is required for Current composition frame."); }
function mimeType(path: string, kind: MediaKind) {
  const extension = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", avi: "video/x-msvideo", webm: "video/webm" };
  return types[extension ?? ""] ?? `${kind}/octet-stream`;
}
