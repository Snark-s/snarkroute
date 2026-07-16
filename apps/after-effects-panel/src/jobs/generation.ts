import type { SnarkRouteGatewayClient } from "../api/client";
import type { AfterEffectsHostAdapter } from "../host/adapter";
import type { CompositionSnapshot, FrameExportDiagnostic, PersistedJob, VideoModel } from "../types";

type PreparationDependencies = {
  host: Pick<AfterEffectsHostAdapter, "getActiveComposition" | "renderCurrentFrame" | "validateInputFile" | "createGenerationPlaceholder">;
  client: Pick<SnarkRouteGatewayClient, "importAsset" | "createJob">;
  readFileBase64(path: string): string;
  now?(): string;
  log?(label: string, details: Record<string, unknown>): void;
  onPhase?(phase: "preparing input" | "uploading"): void;
  onJobPrepared?(job: PersistedJob): void;
  onExportDiagnostic?(diagnostic: FrameExportDiagnostic): void;
};

export type PrepareGenerationInput = {
  serverUrl: string;
  model: VideoModel;
  prompt: string;
  parameters: Record<string, unknown>;
};

export async function prepareGeneration(input: PrepareGenerationInput, dependencies: PreparationDependencies): Promise<PersistedJob> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  dependencies.onPhase?.("preparing input");
  const source = await dependencies.host.getActiveComposition();
  if (!source) throw new Error("Open an active composition first.");

  dependencies.onExportDiagnostic?.({ stage: "exporting_current_frame", exportMethod: "saveFrameToPng", path: "waiting for After Effects…", exists: false, size: 0, waitedMs: 0, attempts: 0, fileError: "", fallbackAttempted: false });
  const frame = await dependencies.host.renderCurrentFrame(source);
  dependencies.onExportDiagnostic?.(frame);
  if (!frame.ok) throw currentFrameExportError(frame.path, `${frame.fileError || "Timed out waiting for PNG data."} (attempts=${frame.attempts}, waitedMs=${frame.waitedMs}, size=${frame.size})`);
  const validated = await dependencies.host.validateInputFile(frame.path);
  assertValidInputFile(validated.path, validated.sizeBytes, validated.fileError);

  let dataBase64: string;
  try {
    dataBase64 = dependencies.readFileBase64(validated.path);
  } catch (error) {
    throw currentFrameExportError(validated.path, error instanceof Error ? error.message : String(error));
  }

  dependencies.onPhase?.("uploading");
  const asset = await dependencies.client.importAsset(frame.filename, dataBase64);
  if (!asset.id || !asset.path) throw new Error("Uploaded input asset did not include an id and path.");

  const diagnostic = inputDiagnostic(source, validated.path, validated.sizeBytes, asset.id, input.model);
  (dependencies.log ?? ((label, details) => console.info(label, details)))("[SnarkRoute] prepared image-to-video input", diagnostic);
  const created = await dependencies.client.createJob({ model: input.model, prompt: input.prompt, parameters: input.parameters, asset });

  let pending: PersistedJob = {
    jobId: created.id,
    serverUrl: input.serverUrl,
    outputPath: "",
    createdAt: created.createdAt,
    status: created.status,
    modelId: input.model.storedModelId,
    provider: input.model.provider,
    prompt: input.prompt,
    params: input.parameters,
    inputPaths: [asset.path],
    inputFramePath: validated.path,
    inputAssetId: asset.id,
    sourceCompositionId: source.id,
    sourceCompositionName: source.name,
    sourceTime: source.time,
    placeholderCreatedAt: null,
    jobCreatedAt: created.createdAt,
    inputFrameExport: frame
  };
  dependencies.onJobPrepared?.(pending);

  try {
    const placeholder = await dependencies.host.createGenerationPlaceholder({
      name: `Generating · ${input.model.displayName}`,
      duration: Number(input.parameters.duration ?? 5),
      compositionId: source.id,
      sourceTime: source.time,
      width: source.width,
      height: source.height,
      frameRate: source.frameRate,
      pixelAspect: source.pixelAspect
    });
    pending = { ...pending, placeholder, placeholderCreatedAt: now() };
  } catch (error) {
    const warning = `Provider job ${created.id} was created, but the After Effects placeholder could not be created: ${error instanceof Error ? error.message : String(error)}`;
    console.error("[SnarkRoute] placeholder creation failed after job creation", { jobId: created.id, inputFramePath: validated.path, error });
    pending = { ...pending, warning };
  }

  dependencies.onJobPrepared?.(pending);
  return pending;
}

export function inputDiagnostic(source: CompositionSnapshot, path: string, sizeBytes: number, assetId: string, model: VideoModel) {
  return {
    compositionName: source.name,
    compositionId: source.id,
    currentTime: source.time,
    exportedPngPath: path,
    pngFileSize: sizeBytes,
    assetId,
    modelId: model.storedModelId,
    providerModelId: model.providerModelId,
    requestImageField: "inputs[0]"
  };
}

function assertValidInputFile(path: string, sizeBytes: number, fileError: string): void {
  const absolute = /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\//.test(path);
  if (!absolute || sizeBytes <= 0 || fileError) throw currentFrameExportError(path, fileError || (!absolute ? "Export path is not absolute." : "File is empty."));
}

function currentFrameExportError(path: string, fileError: string): Error {
  return new Error(`Current frame export failed\nPath: ${path || "unknown"}\nFile.error: ${fileError || "unknown"}`);
}
