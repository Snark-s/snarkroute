import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SnarkRouteGatewayClient, type ConnectionProbeResult } from "../api/client";
import { capabilityForOperation, countModelFamilies, filterModelsForOperation, frontendExclusionReason, maximumImageInputs, modelRequiresPrompt, modelSupportsPrompt, operationLabels, operationsForModels, outputMediaTypeForOperation } from "../api/catalog";
import { gatewayParameters, parameterValidationErrors, parametersFromComposition } from "../api/parameters";
import { ParameterFields } from "../components/ParameterFields";
import { PortableToolFields } from "../components/PortableToolFields";
import { InputSlots } from "../components/InputSlots";
import { JobStageIndicator } from "../components/JobStageIndicator";
import { CepAfterEffectsHostAdapter, readFileBase64, writeBinaryBase64 } from "../host/adapter";
import { prepareGeneration } from "../jobs/generation";
import { generationDirectory } from "../jobs/manifest-writer";
import { postProcessDownloadedJob, retryGenerationManifest } from "../jobs/post-processing";
import { importDownloadedResult } from "../jobs/result-import";
import { clearPendingJob, jobReducer, restorePendingJob, savePendingJob } from "../jobs/state";
import type { FrameExportDiagnostic, GenerationJob, GenerationMetadata, GenerationModel, GenerationOperation, GenerationOutput, PersistedJob } from "../types";
import { useAeMcpBridge } from "../mcp/bridge";
import { addSlotItem, inputSlotsForModel, inputValidationErrors, moveSlotItem, reconcileInputSlots, removeSlotItem } from "../inputs/contracts";
import { restoreGenerationForm, saveGenerationForm } from "../inputs/persistence";
import type { AeInputSource, AeInputSourceType, InputSlotState, MediaKind } from "../types";
import { afterEffectsToolSupport, defaultToolValues, isMediaToolField, manualToolInputs, mediaKindForToolField, normalizeToolValues, sourceForAfterEffects, validateToolValues, type H3RegenerationJob, type H3RegenerationQuote, type PortableToolJob, type PublishedTool } from "../tools/schema";

const defaultServerUrl = "http://127.0.0.1:4317";
const host = new CepAfterEffectsHostAdapter();

export function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem("snarkroute.after-effects.server-url") ?? defaultServerUrl);
  const mcpBridge = useAeMcpBridge(serverUrl);
  const client = useMemo(() => new SnarkRouteGatewayClient(serverUrl), [serverUrl]);
  const [connected, setConnected] = useState(false), [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<ConnectionProbeResult | null>(null);
  const [catalogModels, setCatalogModels] = useState<GenerationModel[]>([]);
  const [publishedTools, setPublishedTools] = useState<PublishedTool[]>([]), [toolId, setToolId] = useState(""), [toolValues, setToolValues] = useState<Record<string, unknown>>({});
  const [toolJob, setToolJob] = useState<PortableToolJob | null>(null), [toolMessage, setToolMessage] = useState(""), [toolArtifacts, setToolArtifacts] = useState<string[]>([]);
  const [h3Regeneration, setH3Regeneration] = useState<H3RegenerationJob | null>(null), [h3Quote, setH3Quote] = useState<H3RegenerationQuote | null>(null), [h3Unavailable, setH3Unavailable] = useState("");
  const [catalogDiagnostics, setCatalogDiagnostics] = useState({ endpoint: "/api/models/executable-generation?materialize=image,audio,video&multipleImages=1", received: 0 });
  const operations = useMemo(() => operationsForModels(catalogModels), [catalogModels]);
  const restoredForm = useMemo(() => restoreGenerationForm(), []);
  const [operation, setOperation] = useState<GenerationOperation>(restoredForm?.operation ?? "image-to-video");
  const models = useMemo(() => filterModelsForOperation(catalogModels, operation), [catalogModels, operation]);
  const [modelId, setModelId] = useState(restoredForm?.modelId ?? ""), [prompt, setPrompt] = useState(""), [parameters, setParameters] = useState<Record<string, unknown>>(restoredForm?.parameters ?? {});
  const [inputSlots, setInputSlots] = useState<InputSlotState[]>(restoredForm?.inputs ?? []), [inputWarning, setInputWarning] = useState("");
  const [sizeMode, setSizeMode] = useState<"composition" | "preset" | "custom">("preset"), [sizeWarning, setSizeWarning] = useState("");
  const [quote, setQuote] = useState("Estimated cost unavailable"), [advancedOpen, setAdvancedOpen] = useState(false);
  const [job, dispatch] = useReducer(jobReducer, { phase: restoredPhase(restorePendingJob()) });
  const [details, setDetails] = useState<PersistedJob | null>(() => restorePendingJob());
  const [exportDiagnostic, setExportDiagnostic] = useState<FrameExportDiagnostic | null>(null);
  const didAutoProbe = useRef(false);
  const selectedModel = models.find((model) => model.id === modelId);
  const selectedTool = publishedTools.find((entry) => entry.tool.id === toolId)?.tool;
  const currentInputErrors = selectedModel ? inputValidationErrors(selectedModel, inputSlots) : [];

  async function connect() {
    localStorage.setItem("snarkroute.after-effects.server-url", serverUrl.replace(/\/$/, "")); setConnecting(true);
    try { const probe = await client.health(); setConnection(probe); setConnected(probe.connected); if (!probe.connected) { setPublishedTools([]); return setCatalogModels([]); } const catalog = await client.models(); setCatalogModels(catalog.models); try { setPublishedTools((await client.tools()).tools); } catch { setPublishedTools([]); } setCatalogDiagnostics({ endpoint: catalog.diagnosticsUrl, received: catalog.modelCount }); const available = operationsForModels(catalog.models); setOperation((current) => available.includes(current) ? current : available[0] ?? "text-to-image"); }
    catch (error) { setCatalogModels([]); setPublishedTools([]); setConnection((current) => ({ connected: false, url: current?.url ?? serverUrl, attemptedAt: new Date().toISOString(), status: current?.status ?? null, responseBody: current?.responseBody ?? "", error: message(error) })); }
    finally { setConnecting(false); }
  }
  useEffect(() => { if (!didAutoProbe.current) { didAutoProbe.current = true; void connect(); } }, []);
  useEffect(() => { setModelId((current) => models.some((model) => model.id === current) ? current : models[0]?.id ?? ""); }, [operation, catalogModels]);
  useEffect(() => { setToolId((current) => publishedTools.some((entry) => entry.tool.id === current) ? current : publishedTools[0]?.tool.id ?? ""); }, [publishedTools]);
  useEffect(() => { if (selectedTool) setToolValues(defaultToolValues(selectedTool)); }, [selectedTool?.id, selectedTool?.schemaVersion]);
  useEffect(() => { setH3Regeneration(null); setH3Quote(null); setH3Unavailable(""); if (selectedTool?.id === "minimax.h3.generate") void client.h3RegenerationAvailability(Number(toolValues.duration ?? 5)).then((value) => { setH3Quote(value.quote); setH3Unavailable(value.available ? "" : value.reason ?? "Regenerate in 2K is unavailable."); }).catch((error) => setH3Unavailable(message(error))); }, [selectedTool?.id, toolValues.duration, client]);
  useEffect(() => { if (!selectedModel) return; setParameters((current) => Object.fromEntries(selectedModel.parameters.map((field) => [field.id, current[field.id] ?? field.default ?? (field.type === "boolean" ? false : "")]))); const migrated = reconcileInputSlots(inputSlotsForModel(selectedModel, operation), inputSlots); setInputSlots(migrated.slots); setInputWarning(migrated.removedFilled ? `${migrated.removedFilled} incompatible filled input(s) were removed after the model contract changed.` : ""); }, [selectedModel?.id, operation]);
  useEffect(() => { if (selectedModel) saveGenerationForm({ operation, modelId: selectedModel.id, inputs: inputSlots, parameters }); }, [operation, selectedModel?.id, inputSlots, parameters]);
  useEffect(() => { const pending = restorePendingJob(); if (connected && pending && !["completed", "completed_with_warning", "failed", "cancelled"].includes(pending.status)) void resume(pending); }, [connected]);

  async function applyCompositionSize() { if (!selectedModel) return; const composition = await host.getActiveComposition(); if (!composition) return setSizeWarning("No active composition; use Model preset or Custom."); const adjusted = parametersFromComposition(selectedModel.parameters, parameters, composition.width, composition.height); setParameters(adjusted.values); setSizeWarning(adjusted.warning ?? `Using ${composition.width} × ${composition.height}.`); }
  async function updateQuote() { if (!selectedModel) return; try { const response = await client.quote(selectedModel, gatewayParameters(selectedModel.parameters, parameters)); const cost = response.selected?.estimatedCost; const count = Number(parameters.numberOfImages ?? parameters.n ?? parameters.numImages ?? 1); setQuote(typeof cost === "number" ? `Estimated total: ${cost} ${response.selected?.currency ?? ""}${count > 1 ? ` · ${(cost / count).toFixed(4)} per image` : ""}`.trim() : "Estimated cost unavailable"); } catch { setQuote("Estimated cost unavailable"); } }

  async function generate() {
    if (!selectedModel) return dispatch({ type: "phase", phase: "failed", message: "Choose a model." });
    if (modelRequiresPrompt(selectedModel) && !prompt.trim()) return dispatch({ type: "phase", phase: "failed", message: "Prompt is required." });
    if (currentInputErrors.length) return dispatch({ type: "phase", phase: "failed", message: currentInputErrors.join(" ") });
    if (sizeMode === "composition") await applyCompositionSize();
    const params = gatewayParameters(selectedModel.parameters, parameters); const errors = parameterValidationErrors(selectedModel.parameters, { ...parameters, prompt });
    if (errors.length) return dispatch({ type: "phase", phase: "failed", message: errors.join(" ") });
    try { setExportDiagnostic(null); const pending = await prepareGeneration({ serverUrl, model: selectedModel, operation, prompt, parameters: params, inputSlots }, { host, client, readFileBase64, onPhase: (phase) => dispatch({ type: "phase", phase }), onJobPrepared: updatePersisted, onExportDiagnostic: setExportDiagnostic }); await pollAndImport(pending); }
    catch (error) { dispatch({ type: "phase", phase: "failed", message: message(error) }); }
  }

  async function runPublishedTool() {
    if (!selectedTool) return;
    const support = afterEffectsToolSupport(selectedTool), errors = validateToolValues(selectedTool, toolValues);
    if (!support.supported || errors.length) return setToolMessage([...support.reasons, ...errors].join(" "));
    setToolMessage("Preparing host inputs…"); setToolArtifacts([]);
    try {
      const composition = await host.getActiveComposition();
      const inputs: Record<string, unknown> = { ...manualToolInputs(selectedTool, toolValues) };
      let preview: { path: string; temporary: boolean } | undefined;
      for (const field of selectedTool.inputs.filter(isMediaToolField)) {
        const source = sourceForAfterEffects(field), kind = mediaKindForToolField(field);
        if (kind === "text") continue;
        let path = "", temporary = false;
        if (source === "upload") path = await host.selectExternalFile(kind) ?? "";
        else {
          if (!composition) throw new Error(`Open an active composition for ${field.label ?? field.id}.`);
          const rendered = source === "host_first_frame" ? await host.renderFrameAtTime({ compositionId: composition.id, time: 0 }) : source === "host_last_frame" ? await host.renderFrameAtTime({ compositionId: composition.id, time: Math.max(0, composition.duration - 1 / composition.frameRate) }) : source === "host_active_layer" ? await host.renderSelectedLayerCurrentFrame({ compositionId: composition.id, time: composition.time }) : await host.renderCurrentFrame(composition);
          if (!rendered.ok) throw new Error(rendered.fileError || `Could not capture ${field.label ?? field.id}.`);
          path = rendered.path; temporary = true;
        }
        if (!path) { if (field.required) throw new Error(`${field.label ?? field.id} is required.`); continue; }
        const valid = await host.validateInputFile(path), filename = fileName(path), imported = await client.importAsset(filename, readFileBase64(path), kind);
        inputs[field.id] = { type: kind, assetId: imported.id, path: imported.path, filename, mimeType: inputMimeType(path, kind) };
        preview ??= kind === "image" || kind === "video" ? { path, temporary } : undefined;
      }
      const correlationId = composition ? `ae:comp-${composition.id}` : "ae:no-comp";
      const created = await client.createToolJob(selectedTool.id, { schemaVersion: selectedTool.schemaVersion, hostType: "after_effects", inputs, parameters: normalizeToolValues(selectedTool, toolValues), sourceContext: composition ? { compositionId: composition.id, compositionName: composition.name, time: composition.time } : {}, correlationId, idempotencyKey: `${correlationId}:${selectedTool.id}:${Date.now()}` });
      let placeholder: Awaited<ReturnType<typeof host.createGenerationPlaceholder>> | undefined;
      const primaryOutput = selectedTool.outputs[0], placement = primaryOutput?.hostPlacements?.after_effects ?? primaryOutput?.placement;
      if (composition && preview && placement === "replace_placeholder" && primaryOutput && mediaKindForToolField(primaryOutput) !== "audio") placeholder = await host.createGenerationPlaceholder({ jobId: created.id, modelId: selectedTool.id, displayName: selectedTool.title, name: `Generating · ${selectedTool.title}`, duration: Number(toolValues.duration ?? 5), compositionId: composition.id, sourceTime: composition.time, width: composition.width, height: composition.height, frameRate: composition.frameRate, pixelAspect: composition.pixelAspect, mediaKind: mediaKindForToolField(primaryOutput) as MediaKind, previewPath: preview.path, previewKind: mediaKindForToolField(selectedTool.inputs.find((field) => isMediaToolField(field))!) as MediaKind, previewTemporary: preview.temporary });
      setToolJob(created); setToolMessage(created.status);
      let remote = created;
      while (!['completed', 'failed', 'cancelled'].includes(remote.status)) { await delay(1000); remote = await client.toolJob(created.id); setToolJob(remote); setToolMessage(`${remote.status} · ${Math.round(remote.progress * 100)}%`); }
      if (remote.status === "failed") throw new Error(remote.error ?? "Portable tool failed.");
      if (remote.status === "cancelled") return setToolMessage("cancelled");
      const context = await host.getProjectFileContext(), artifacts: string[] = [];
      for (const result of remote.results ?? []) {
        if (result.type === "text") { if (result.text) artifacts.push(result.text); continue; }
        if (!result.url) continue;
        const kind = result.type, directory = await generationDirectory(context, kind), outputPath = joinPath(directory, result.filename ?? `${remote.id}-${result.id}`);
        writeBinaryBase64(outputPath, await client.download(result.url)); await host.validateInputFile(outputPath); artifacts.push(outputPath);
        if (kind === "audio") continue;
        const imported = await host.importResultFootage(outputPath, result.filename ?? `${selectedTool.title}-${result.id}`, kind);
        if (!imported.ok || !imported.importedItemId) throw new Error(imported.importError ?? "After Effects could not import the tool result.");
        const output = selectedTool.outputs.find((candidate) => candidate.id === result.outputId), outputPlacement = output?.hostPlacements?.after_effects ?? output?.placement;
        if (placeholder && outputPlacement === "replace_placeholder" && result.id === remote.results?.[0]?.id) await host.replacePlaceholderSource(placeholder, imported.importedItemId, result.filename ?? selectedTool.title);
      }
      setToolArtifacts(artifacts); setToolMessage("completed");
    } catch (error) { setToolMessage(message(error)); }
  }

  async function cancelPublishedTool() { if (!toolJob || ["completed", "failed", "cancelled"].includes(toolJob.status)) return; const cancelled = await client.cancelToolJob(toolJob.id); setToolJob(cancelled); setToolMessage("cancelled"); }
  async function selectPublishedResult(resultId: string) { if (!toolJob) return; try { setToolJob(await client.selectToolResult(toolJob.id, resultId)); } catch (error) { setToolMessage(message(error)); } }
  async function regenerateSelectedH3() {
    if (!toolJob?.selectedResultId || selectedTool?.id !== "minimax.h3.generate" || h3Unavailable) return;
    try {
      let remote = await client.regenerateH3In2K(toolJob.id, toolJob.selectedResultId, `ae:${toolJob.id}:${toolJob.selectedResultId}:2k`); setH3Regeneration(remote);
      while (!["completed", "failed", "cancelled"].includes(remote.status)) { await delay(1500); remote = await client.h3RegenerationJob(remote.id); setH3Regeneration(remote); }
      if (remote.status !== "completed" || !remote.result) throw new Error(remote.error ?? `2K regeneration ${remote.status}.`);
      const context = await host.getProjectFileContext(), directory = await generationDirectory(context, "video"), outputPath = joinPath(directory, remote.result.filename);
      writeBinaryBase64(outputPath, await client.download(remote.result.url)); await host.validateInputFile(outputPath);
      const imported = await host.importResultFootage(outputPath, remote.result.filename, "video");
      if (!imported.ok) throw new Error(imported.importError ?? "After Effects could not import the 2K regeneration.");
      setToolArtifacts((current) => [...current, outputPath]);
    } catch (error) { setToolMessage(message(error)); }
  }
  async function cancelH3Regeneration() { if (!h3Regeneration || ["completed", "failed", "cancelled"].includes(h3Regeneration.status)) return; setH3Regeneration(await client.cancelH3Regeneration(h3Regeneration.id)); }
  async function cancelGeneration() { if (!details || !isBusy(job.phase)) return; const cancelled = await client.cancelJob(details.jobId); const updated = { ...details, status: cancelled.status, lastStage: cancelled.status }; updatePersisted(updated); dispatch({ type: "phase", phase: "cancelled", message: "Generation cancelled.", jobId: details.jobId }); }

  async function pollAndImport(pending: PersistedJob) {
    let remote: GenerationJob;
    do { remote = await client.job(pending.jobId); const phase = remote.status === "queued" || remote.status === "starting_provider" || remote.status === "loading_model" ? "provider_queued" : remote.status === "failed" || remote.status === "cancelled" ? "failed" : remote.status === "downloading" || remote.status === "completed" ? "downloading_results" : "provider_running"; pending = persistStage(pending, phase, setDetails); dispatch({ type: "phase", phase, message: remote.error ?? remote.status, jobId: remote.id }); if (remote.status === "failed" || remote.status === "cancelled") throw new Error(remote.error ?? `Generation ${remote.status}.`); if (remote.status !== "completed") await delay(1500); } while (remote.status !== "completed");
    const mediaKind = remote.outputMediaType ?? pending.outputMediaType ?? "video"; const descriptors = remote.outputs?.length ? remote.outputs : remote.result && remote.resultUrl ? [{ kind: mediaKind, role: "primary", index: 0, filename: remote.result.filename, mimeType: remote.result.mimeType, resultUrl: remote.resultUrl }] : [];
    if (!descriptors.length) throw new Error("Completed job did not include downloadable outputs.");
    const context = await host.getProjectFileContext(), directory = await generationDirectory(context, mediaKind); const outputs: GenerationOutput[] = [];
    for (const descriptor of descriptors) { const resultUrl = descriptor.resultUrl ?? remote.resultUrl; if (!resultUrl) throw new Error(`Output ${descriptor.index} has no download URL.`); const outputPath = joinPath(directory, descriptor.filename || `${remote.id}-${descriptor.index}`); writeBinaryBase64(outputPath, await client.download(resultUrl)); const valid = await host.validateInputFile(outputPath); if (valid.sizeBytes <= 0 || valid.fileError) throw new Error(`Downloaded ${mediaKind} validation failed: ${valid.fileError || "file is empty"}`); outputs.push({ ...descriptor, path: outputPath, fileSize: valid.sizeBytes }); }
    const primary = outputs[0], manifestPath = `${primary.path}.json`;
    const metadata: GenerationMetadata = { jobId: remote.id, operation: pending.operation, outputMediaType: mediaKind, modelId: pending.modelId, providerModelId: pending.providerModelId, provider: pending.provider, capability: pending.capability ?? capabilityForOperation(pending.operation ?? "image-to-video"), prompt: pending.prompt, params: pending.params, inputs: pending.inputs ?? pending.inputPaths, outputs, primaryOutputIndex: 0, createdAt: pending.createdAt, estimatedCost: remote.result?.estimatedCost ?? null, actualCost: remote.result?.actualCost ?? null, manifestPath, outputPath: primary.path, projectSaved: context.saved, projectFilePath: context.projectFilePath, projectFolder: mediaKind === "image" ? "SnarkRoute Generations/Images" : "SnarkRoute Generations/Videos", inputFramePath: pending.inputFramePath, inputAssetId: pending.inputAssetId, sourceCompositionId: pending.sourceCompositionId, sourceCompositionName: pending.sourceCompositionName, sourceTime: pending.sourceTime, placeholder: pending.placeholder, placeholderCreatedAt: pending.placeholderCreatedAt, jobCreatedAt: pending.jobCreatedAt };
    const downloaded: PersistedJob = { ...pending, outputPath: primary.path!, outputs, primaryOutputIndex: 0, status: "results_downloaded", lastStage: "results_downloaded", metadata }; updatePersisted(downloaded); dispatch({ type: "phase", phase: "results_downloaded", message: `${outputs.length} result(s) downloaded`, jobId: remote.id });
    const completed = await postProcessDownloadedJob(downloaded, metadata, { host, onPhase: (phase) => dispatch({ type: "phase", phase, jobId: pending.jobId }), onUpdate: updatePersisted }); finishVisibleState(completed, dispatch);
  }

  async function resume(pending: PersistedJob) { try { if (pending.outputs?.some((output) => output.path) && pending.metadata) finishVisibleState(await postProcessDownloadedJob(pending, pending.metadata, { host, onPhase: (phase) => dispatch({ type: "phase", phase, jobId: pending.jobId }), onUpdate: updatePersisted }), dispatch); else await pollAndImport(pending); } catch (error) { dispatch({ type: "phase", phase: "failed", message: message(error) }); } }
  async function retryImport(pending: PersistedJob) { if (!pending.metadata) return; finishVisibleState(await importDownloadedResult(pending, pending.metadata, { host, onPhase: (phase) => dispatch({ type: "phase", phase, jobId: pending.jobId }), onUpdate: updatePersisted }), dispatch); }
  async function retryManifest(pending: PersistedJob) { finishVisibleState(await retryGenerationManifest(pending, { onPhase: (phase) => dispatch({ type: "phase", phase, jobId: pending.jobId }), onUpdate: updatePersisted }), dispatch); }
  function updatePersisted(value: PersistedJob) { savePendingJob(value); setDetails(value); }
  function updateSlot(slotId: string, update: (slot: InputSlotState) => InputSlotState) { setInputSlots((current) => current.map((slot) => slot.slotId === slotId ? update(slot) : slot)); }
  function setSlotSource(slotId: string, index: number, source: AeInputSource | null) { updateSlot(slotId, (slot) => ({ ...slot, items: slot.items.map((item, itemIndex) => itemIndex === index ? source : item) })); }
  async function chooseInputSource(slotId: string, index: number, sourceType: AeInputSourceType | "none") {
    const slot = inputSlots.find((candidate) => candidate.slotId === slotId); if (!slot) return;
    if (sourceType === "none") return setSlotSource(slotId, index, null);
    if (sourceType === "current-composition-frame") {
      setSlotSource(slotId, index, { sourceType, kind: "image", validationState: "ready" });
      const composition = await host.getActiveComposition();
      if (composition && selectedModel) { const adjusted = parametersFromComposition(selectedModel.parameters, parameters, composition.width, composition.height); setParameters(adjusted.values); setSizeWarning(adjusted.warning ?? ""); }
      return;
    }
    try {
      if (sourceType === "captured-composition-frame") {
        const composition = await host.getActiveComposition(); if (!composition) throw new Error("Open an active composition before capturing a frame.");
        if (selectedModel) { const adjusted = parametersFromComposition(selectedModel.parameters, parameters, composition.width, composition.height); setParameters(adjusted.values); setSizeWarning(adjusted.warning ?? ""); }
        const rendered = await host.renderCurrentFrame(composition); if (!rendered.ok) throw new Error(rendered.fileError || "Frame capture failed.");
        const validated = await host.validateInputFile(rendered.path);
        return setSlotSource(slotId, index, { sourceType, kind: "image", path: validated.path, filename: rendered.filename, mimeType: "image/png", fileSize: validated.sizeBytes, compositionId: composition.id, compositionName: composition.name, compositionTime: composition.time, validationState: "ready" });
      }
      const path = await host.selectExternalFile(slot.kind); if (!path) return;
      assertSupportedExternalPath(path, slot.kind); const validated = await host.validateInputFile(path);
      setSlotSource(slotId, index, { sourceType: "external-file", kind: slot.kind, path: validated.path, filename: fileName(validated.path), mimeType: inputMimeType(validated.path, slot.kind), fileSize: validated.sizeBytes, validationState: "ready" });
    } catch (error) { setSlotSource(slotId, index, { sourceType: sourceType as AeInputSourceType, kind: slot.kind, validationState: "invalid", error: message(error) }); }
  }
  const importedIds = details?.importedOutputs?.flatMap((item) => item.importedItemId ? [item.importedItemId] : []) ?? [];
  const currentParameterErrors = selectedModel ? parameterValidationErrors(selectedModel.parameters, { ...parameters, prompt }) : [];
  const promptError = selectedModel && modelRequiresPrompt(selectedModel) && !prompt.trim() ? "Prompt is required." : "";
  const generateBlockReason = !connected ? "Connect to the SnarkRoute server." : !selectedModel ? "Choose an executable model." : isBusy(job.phase) ? "The current job is still running." : currentInputErrors[0] || promptError || currentParameterErrors[0] || "";
  const excludedModels = catalogModels.map((model) => ({ model: model.displayName, reason: frontendExclusionReason(model, operation) })).filter((item) => item.reason);
  const toolSupport = selectedTool ? afterEffectsToolSupport(selectedTool) : null;
  const visibleToolFields = selectedTool ? [...(selectedTool.params ?? []), ...selectedTool.inputs.filter((field) => !isMediaToolField(field) && sourceForAfterEffects(field) === "manual")] : [];
  const toolBusy = toolJob ? !["completed", "failed", "cancelled"].includes(toolJob.status) : false;

  return <main>
    <section><h2>MCP / After Effects</h2><BridgeState label="MCP server" value={mcpBridge.mcpServerStatus} /><BridgeState label="AE Bridge" value={mcpBridge.bridgeStatus} /><BridgeState label="AE session" value={mcpBridge.sessionStatus} /><details><summary>Bridge diagnostics</summary><div className="diagnostics"><div>MCP URL: {mcpBridge.mcpUrl || "invalid"}</div><div>Bridge WebSocket URL: {mcpBridge.webSocketUrl || "invalid"}</div><div>Pairing status: {mcpBridge.pairingStatus}</div><div>Session ID: {mcpBridge.sessionId || "none"}</div><div>Last attempt: {mcpBridge.lastAttemptAt || "none"}</div><div>Last connected: {mcpBridge.lastConnectedAt || "none"}</div><div>Last close: {mcpBridge.lastCloseCode ?? "none"} · {mcpBridge.lastCloseReason || "no reason"}</div><div>Reconnect attempts: {mcpBridge.reconnectAttempts}</div><div>Connection prerequisite: {mcpBridge.connectionPrerequisite}</div><div>Last bridge error: {mcpBridge.lastError || "none"}</div></div></details></section>
    <section><h2>Connection</h2><label className="field"><span>Server URL</span><input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} /></label><div className={connected ? "status ok" : "status error"}>SnarkRoute server: {connecting ? "connecting…" : connected ? "connected" : "disconnected"}</div>{connection?.error && <div className="error-text">{connection.error}</div>}<button onClick={() => void connect()} disabled={connecting}>Reconnect</button>{connection && <div className="diagnostics"><div>URL: {connection.url}</div><div>Last attempt: {connection.attemptedAt}</div><div>Status: {connection.status ?? "fetch failed"}</div><div>Response: {connection.responseBody.slice(0, 300) || "empty"}</div><div>Error: {connection.error || "none"}</div></div>}</section>
    <section><h2>Published tools</h2>{publishedTools.length ? <><select aria-label="Published tool" value={toolId} onChange={(event) => setToolId(event.target.value)}>{publishedTools.map((entry) => <option key={entry.tool.id} value={entry.tool.id}>{entry.tool.title} · v{entry.tool.version}</option>)}</select>{selectedTool && <><p>{selectedTool.description}</p><div className="diagnostics">Inputs: {selectedTool.inputs.map((field) => `${field.label ?? field.id} ← ${sourceForAfterEffects(field)}`).join(" · ")}<br />Outputs: {selectedTool.outputs.map((field) => `${field.label ?? field.id} → ${field.hostPlacements?.after_effects ?? field.placement}`).join(" · ")}</div><PortableToolFields fields={visibleToolFields} values={toolValues} onChange={(id, value) => setToolValues((current) => ({ ...current, [id]: value }))} />{toolSupport?.reasons.map((reason) => <div className="error-text" key={reason}>{reason}</div>)}<button className="primary" onClick={() => void runPublishedTool()} disabled={!connected || !toolSupport?.supported || toolBusy}>Run tool</button>{toolBusy && selectedTool.job.cancellable && <button onClick={() => void cancelPublishedTool()}>Cancel tool job</button>}<div className={toolMessage && !["completed", "cancelled"].includes(toolMessage) && toolJob?.status === "failed" ? "error-text" : "diagnostics"}>{toolMessage || "Ready"}</div>{toolJob?.status === "completed" && toolJob.results && <div>{toolJob.results.map((result) => <button key={result.id} onClick={() => void selectPublishedResult(result.id)} disabled={toolJob.selectedResultId === result.id}>{toolJob.selectedResultId === result.id ? "Selected" : "Select"} · {result.label}</button>)}</div>}{selectedTool.id === "minimax.h3.generate" && toolJob?.selectedResultId && <div className="diagnostics">{h3Quote && <>Regenerate in 2K estimate: {h3Quote.providerUsd.toFixed(2)} USD · {h3Quote.finalCredits} credits</>}{h3Unavailable && <div className="error-text">{h3Unavailable}</div>}<button onClick={() => void regenerateSelectedH3()} disabled={Boolean(h3Unavailable) || Boolean(h3Regeneration && !["completed", "failed", "cancelled"].includes(h3Regeneration.status))}>Regenerate in 2K</button>{h3Regeneration && <span> {h3Regeneration.status} · {Math.round(h3Regeneration.progress * 100)}%</span>}{h3Regeneration && !["completed", "failed", "cancelled"].includes(h3Regeneration.status) && <button onClick={() => void cancelH3Regeneration()}>Cancel 2K regeneration</button>}</div>}{toolArtifacts.map((artifact) => <div key={artifact}>{artifact}</div>)}</>}</> : <small>No valid tools are published for After Effects.</small>}</section>
    <section><h2>Operation</h2>{operations.length === 1 ? <input readOnly value={operationLabels[operations[0]]} /> : <select value={operation} onChange={(event) => setOperation(event.target.value as GenerationOperation)}>{operations.map((value) => <option key={value} value={value}>{operationLabels[value]}</option>)}</select>}<small>Only operations backed by live executable catalog models are shown.</small></section>
    <section><h2>Model</h2><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((model) => <option key={`${model.nodeType}:${model.id}`} value={model.id}>{model.displayName} · {model.provider}</option>)}</select>{selectedModel && <small>{selectedModel.availability.status} · output {outputMediaTypeForOperation(operation)} · up to {maximumImageInputs(selectedModel)} image input(s)</small>}<div className="diagnostics">Executable models after frontend compatibility: {models.length} · Families: {countModelFamilies(models)} · Server returned: {catalogDiagnostics.received}</div></section>
    <section><h2>Inputs</h2><InputSlots slots={inputSlots} onSource={(slotId, index, source) => void chooseInputSource(slotId, index, source)} onAdd={(slotId) => updateSlot(slotId, addSlotItem)} onRemove={(slotId, index) => updateSlot(slotId, (slot) => removeSlotItem(slot, index))} onMove={(slotId, index, direction) => updateSlot(slotId, (slot) => moveSlotItem(slot, index, direction))} onReveal={(path) => void host.revealFile(path)} />{inputWarning && <div className="error-text">{inputWarning}</div>}{currentInputErrors.map((error) => <div className="error-text" key={error}>{error}</div>)}</section>
    {selectedModel && modelSupportsPrompt(selectedModel) && <section><h2>Prompt</h2><label className="field"><span>Describe what to generate</span><textarea aria-label="Prompt" placeholder="Enter a prompt for the model" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>{modelRequiresPrompt(selectedModel) && !prompt.trim() && <small>Required for this model.</small>}</section>}
    {selectedModel && <section><h2>Parameters</h2><label className="field"><span>Image size</span><select value={sizeMode} onChange={(event) => setSizeMode(event.target.value as typeof sizeMode)}><option value="composition">From composition</option><option value="preset">Model preset</option><option value="custom">Custom</option></select></label>{sizeMode === "composition" && <button onClick={() => void applyCompositionSize()}>Apply composition size</button>}{sizeWarning && <small>{sizeWarning}</small>}<ParameterFields fields={selectedModel.parameters} values={parameters} onChange={(id, value) => setParameters((current) => ({ ...current, [id]: value }))} /><button className="link" onClick={() => setAdvancedOpen((value) => !value)}>Advanced parameters {advancedOpen ? "▴" : "▾"}</button>{advancedOpen && <ParameterFields advanced fields={selectedModel.parameters} values={parameters} onChange={(id, value) => setParameters((current) => ({ ...current, [id]: value }))} />}</section>}
    <section><h2>Quote</h2><div>{quote}</div><button onClick={() => void updateQuote()} disabled={!selectedModel}>Refresh quote</button></section>
    <section><button className="primary" onClick={() => void generate()} disabled={Boolean(generateBlockReason)}>Generate</button>{generateBlockReason && <small>Generate unavailable: {generateBlockReason}</small>}</section>
    <section><h2>Current job</h2><JobStageIndicator stage={job.phase} status={details?.status} message={job.message} />{isBusy(job.phase) && details && <button onClick={() => void cancelGeneration()}>Cancel generation</button>}{(exportDiagnostic ?? details?.inputFrameExport) && <ExportDiagnostics diagnostic={(exportDiagnostic ?? details?.inputFrameExport)!} />}</section>
    {details?.outputs?.length ? <section><h2>Results</h2><div>Primary {details.outputMediaType}: {details.importedOutputs?.[0]?.importedItemName ?? details.outputs[0].filename}</div><div>Size: {details.importedOutputs?.[0]?.width ?? details.outputs[0].width ?? "?"} × {details.importedOutputs?.[0]?.height ?? details.outputs[0].height ?? "?"}</div><div>Project folder: {details.outputMediaType === "image" ? "SnarkRoute Generations/Images" : "SnarkRoute Generations/Videos"}</div>{details.outputs.map((output) => <div key={output.index}>{output.index + 1}. {output.filename}</div>)}{details.manifestDiagnostic && !details.manifestDiagnostic.ok && <button onClick={() => void retryManifest(details)}>Retry manifest</button>}<button onClick={() => void retryImport(details)}>Retry import</button>{details.outputPath && <><button onClick={() => void host.revealFile(details.outputPath)}>Reveal output file</button><button onClick={() => void host.openFile(details.outputPath)}>Open output file</button></>}{importedIds[0] && <><button onClick={() => void host.revealProjectItem(importedIds[0])}>Reveal in Project</button><button onClick={() => void host.addProjectItemToActiveComposition(importedIds[0])}>Add to active composition</button>{details.outputMediaType === "image" && <button onClick={() => void host.createCompositionFromImage(importedIds[0])}>Create composition from image</button>}</>}{importedIds.length > 1 && <button onClick={() => void host.addAllToActiveComposition(importedIds)}>Add all to composition</button>}<button onClick={() => void copyText(JSON.stringify(details, null, 2))}>Copy diagnostics</button></section> : null}
    {(details?.status === "completed" || details?.status === "completed_with_warning") && <section><h2>Generation details</h2><div>{details.jobId}</div><button onClick={() => void generate()}>Regenerate</button><button onClick={() => { clearPendingJob(); setDetails(null); dispatch({ type: "reset" }); }}>Clear</button></section>}
    <section><details><summary>Catalog and input diagnostics</summary><div className="diagnostics"><div>Operation: {operation}</div><div>Catalog endpoint: {catalogDiagnostics.endpoint}</div><div>Server models: {catalogDiagnostics.received}</div><div>Displayed for {operation}: {models.length}</div><div>Selected model: {selectedModel ? `${selectedModel.id} · ${selectedModel.providerModelId}` : "none"}</div><div>Selected contract: {selectedModel ? JSON.stringify(selectedModel.inputContract ?? null) : "none"}</div><div>Normalized inputs: {JSON.stringify(inputSlots.flatMap((slot) => slot.items.flatMap((item, index) => item ? [{ kind: slot.kind, role: slot.role, index, source: item.sourceType, path: item.path, validation: item.validationState }] : [])))}</div><div>Normalized params: {JSON.stringify(selectedModel ? gatewayParameters(selectedModel.parameters, parameters) : {})}</div><div>Provider mapping preview: {JSON.stringify({ images: inputSlots.filter((slot) => slot.kind === "image").map((slot) => slot.role), audios: inputSlots.filter((slot) => slot.kind === "audio").map((slot) => slot.role), videos: inputSlots.filter((slot) => slot.kind === "video").map((slot) => slot.role) })}</div><div>Frontend exclusions: {JSON.stringify(excludedModels)}</div><div>Build: {__SNARKROUTE_BUILD_COMMIT__} · {__SNARKROUTE_BUILD_TIMESTAMP__}</div></div></details></section>
    <footer>Build: {__SNARKROUTE_BUILD_COMMIT__} · {__SNARKROUTE_BUILD_TIMESTAMP__}</footer>
  </main>;
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function BridgeState({ label, value }: { label: string; value: string }) { const running = value === "checking" || value === "pairing" || value === "connecting"; const success = value === "reachable" || value === "connected" || value === "registered"; return <div className={`job-stage ${running ? "job-stage-running" : success ? "job-stage-success" : "job-stage-error"}`} role="status" aria-live="polite"><span className="job-stage-dot" aria-hidden="true">●</span><span className="job-stage-text">{label}: {value}</span></div>; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function joinPath(directory: string, filename: string) { return `${directory.replace(/[\\\/]$/, "")}\\${filename.replace(/[\\/:*?"<>|]/g, "_")}`; }
async function copyText(value: string) { if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value); const area = document.createElement("textarea"); area.value = value; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }
function isBusy(phase: string) { return ["exporting_current_frame", "validating_input", "uploading_asset", "creating_job", "provider_queued", "provider_running", "downloading_results", "importing_images", "importing_video", "replacing_placeholder", "writing_manifest", "writing_ae_metadata"].includes(phase); }
function ExportDiagnostics({ diagnostic }: { diagnostic: FrameExportDiagnostic }) { return <div className="diagnostics"><div>Input export: {diagnostic.path}</div><div>{diagnostic.size} bytes · {diagnostic.waitedMs} ms</div><div>File.error: {diagnostic.fileError || "none"}</div></div>; }
function persistStage(value: PersistedJob, stage: string, setDetails: (job: PersistedJob) => void) { const updated = { ...value, status: stage, lastStage: stage }; savePendingJob(updated); setDetails(updated); return updated; }
function finishVisibleState(completed: PersistedJob, dispatch: React.Dispatch<import("../jobs/state").JobAction>) { const phase = completed.status === "completed" ? "completed" : completed.status === "completed_with_warning" ? "completed_with_warning" : "failed"; dispatch({ type: "phase", phase, message: completed.warning ?? completed.outputPath, jobId: completed.jobId }); }
function restoredPhase(value: PersistedJob | null): import("../jobs/state").JobPhase { const phase = value?.lastStage ?? value?.status; return ["exporting_current_frame", "validating_input", "uploading_asset", "creating_job", "provider_queued", "provider_running", "downloading_results", "results_downloaded", "importing_images", "importing_video", "replacing_placeholder", "organizing_project_items", "writing_manifest", "writing_ae_metadata", "completed", "completed_with_warning", "failed", "cancelled"].includes(phase ?? "") ? phase as import("../jobs/state").JobPhase : "idle"; }
function fileName(path: string) { return path.replace(/\\/g, "/").split("/").pop() || "input"; }
function assertSupportedExternalPath(path: string, kind: MediaKind) { const extensions: Record<MediaKind, RegExp> = { image: /\.(png|jpe?g|webp|tiff?)$/i, audio: /\.(wav|mp3|m4a|aac|flac)$/i, video: /\.(mp4|mov|m4v|avi|mxf|webm)$/i }; if (!extensions[kind].test(path)) throw new Error(`Unsupported ${kind} file: ${fileName(path)}`); }
function inputMimeType(path: string, kind: MediaKind) { const extension = path.split(".").pop()?.toLowerCase(); const known: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm" }; return known[extension ?? ""] ?? `${kind}/octet-stream`; }
