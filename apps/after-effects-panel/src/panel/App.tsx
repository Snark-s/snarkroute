import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SnarkRouteGatewayClient, type ConnectionProbeResult } from "../api/client";
import { countModelFamilies, filterExecutableVideoModels } from "../api/catalog";
import { gatewayParameters } from "../api/parameters";
import { ParameterFields } from "../components/ParameterFields";
import { CepAfterEffectsHostAdapter, readFileBase64, writeBinaryBase64, writeText } from "../host/adapter";
import { serializeGenerationManifest } from "../jobs/manifest";
import { prepareGeneration } from "../jobs/generation";
import { importDownloadedResult } from "../jobs/result-import";
import { clearPendingJob, jobReducer, restorePendingJob, savePendingJob } from "../jobs/state";
import type { FrameExportDiagnostic, GenerationJob, GenerationMetadata, PersistedJob, VideoModel } from "../types";

const defaultServerUrl = "http://127.0.0.1:4317";
const host = new CepAfterEffectsHostAdapter();

export function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem("snarkroute.after-effects.server-url") ?? defaultServerUrl);
  const client = useMemo(() => new SnarkRouteGatewayClient(serverUrl), [serverUrl]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<ConnectionProbeResult | null>(null);
  const [models, setModels] = useState<VideoModel[]>([]);
  const [modelDiagnosticsUrl, setModelDiagnosticsUrl] = useState("/api/models/for-node/polza.video.generate/debug");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [quote, setQuote] = useState<string>("Estimated cost unavailable");
  const [job, dispatch] = useReducer(jobReducer, { phase: "idle" });
  const [details, setDetails] = useState<PersistedJob | null>(() => restorePendingJob());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [exportDiagnostic, setExportDiagnostic] = useState<FrameExportDiagnostic | null>(null);
  const didAutoProbe = useRef(false);
  const selectedModel = models.find((model) => model.id === modelId);

  async function connect() {
    localStorage.setItem("snarkroute.after-effects.server-url", serverUrl.replace(/\/$/, ""));
    setConnecting(true);
    try {
      const probe = await client.health();
      setConnection(probe);
      setConnected(probe.connected);
      if (!probe.connected) {
        setModels([]);
        return;
      }
      const catalog = await client.models();
      const available = filterExecutableVideoModels(catalog.models, "image-to-video");
      setModelDiagnosticsUrl(catalog.diagnosticsUrl);
      setModels(available);
      setModelId((current) => available.some((model) => model.id === current) ? current : available[0]?.id ?? "");
    } catch (error) {
      const exactError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      setModels([]);
      setConnection((current) => ({ connected: true, url: current?.url ?? `${serverUrl.replace(/\/$/, "")}/health`, attemptedAt: current?.attemptedAt ?? new Date().toISOString(), status: current?.status ?? 200, responseBody: current?.responseBody ?? "", error: `Model catalog: ${exactError}` }));
      console.error("[SnarkRoute] model catalog load failed", error);
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => { if (didAutoProbe.current) return; didAutoProbe.current = true; void connect(); }, []);
  useEffect(() => { if (!selectedModel) return; setParameters(Object.fromEntries(selectedModel.parameters.map((field) => [field.id, field.default ?? (field.type === "boolean" ? false : "")]))); }, [selectedModel?.id]);
  useEffect(() => { const pending = restorePendingJob(); if (pending && pending.status !== "completed" && pending.status !== "completed_with_warning" && pending.status !== "failed") void resume(pending); }, [connected]);

  async function updateQuote() {
    if (!selectedModel) return;
    try { const response = await client.quote(selectedModel, gatewayParameters(selectedModel.parameters, parameters)); const cost = response.selected?.estimatedCost; setQuote(typeof cost === "number" ? `Estimated: ${cost} ${response.selected?.currency ?? ""}`.trim() : "Estimated cost unavailable"); } catch { setQuote("Estimated cost unavailable"); }
  }

  async function generate() {
    if (!selectedModel || !prompt.trim()) return dispatch({ type: "phase", phase: "failed", message: "Choose a model and enter a prompt." });
    try {
      setExportDiagnostic(null);
      const params = gatewayParameters(selectedModel.parameters, parameters);
      const pending = await prepareGeneration({ serverUrl, model: selectedModel, prompt, parameters: params }, {
        host,
        client,
        readFileBase64,
        onPhase: (phase) => dispatch({ type: "phase", phase }),
        onJobPrepared: (prepared) => { savePendingJob(prepared); setDetails(prepared); },
        onExportDiagnostic: setExportDiagnostic
      });
      savePendingJob(pending); setDetails(pending);
      await pollAndImport(pending);
    } catch (error) { dispatch({ type: "phase", phase: "failed", message: message(error) }); }
  }

  async function resume(pending: PersistedJob) { if (pending.serverUrl !== serverUrl) return; try { if (pending.outputPath && pending.metadata) await retryImport(pending); else await pollAndImport(pending); } catch (error) { dispatch({ type: "phase", phase: "failed", message: message(error) }); } }

  async function pollAndImport(pending: PersistedJob) {
    let remote: GenerationJob;
    do { remote = await client.job(pending.jobId); dispatch({ type: "phase", phase: remote.status === "queued" ? "queued" : remote.status === "running" ? "running" : remote.status === "failed" ? "failed" : "downloading", message: remote.error, jobId: remote.id }); if (remote.status === "failed") throw new Error(remote.error ?? "Generation failed."); if (remote.status !== "completed") await delay(1500); } while (remote.status !== "completed");
    if (!remote.resultUrl || !remote.result) throw new Error("Completed job did not include a downloadable result.");
    const directory = await host.generationDirectory();
    const outputPath = joinPath(directory, remote.result.filename || `${remote.id}.mp4`);
    dispatch({ type: "phase", phase: "downloading", jobId: remote.id }); writeBinaryBase64(outputPath, await client.download(remote.resultUrl));
    const downloaded = await host.validateInputFile(outputPath);
    if (downloaded.sizeBytes <= 0 || downloaded.fileError) throw new Error(`Downloaded video validation failed: ${downloaded.fileError || "file is empty"}`);
    const manifestPath = `${outputPath}.json`;
    const metadata: GenerationMetadata = { jobId: remote.id, modelId: pending.modelId, provider: pending.provider, capability: "video.generate", prompt: pending.prompt, params: pending.params, inputs: pending.inputPaths, createdAt: pending.createdAt, estimatedCost: remote.result.estimatedCost, actualCost: remote.result.actualCost, manifestPath, inputFramePath: pending.inputFramePath, inputAssetId: pending.inputAssetId, sourceCompositionId: pending.sourceCompositionId, sourceCompositionName: pending.sourceCompositionName, sourceTime: pending.sourceTime, placeholderCreatedAt: pending.placeholderCreatedAt, jobCreatedAt: pending.jobCreatedAt };
    writeText(manifestPath, serializeGenerationManifest(metadata));
    const videoDownloaded = { ...pending, outputPath, status: "video_downloaded", metadata };
    savePendingJob(videoDownloaded); setDetails(videoDownloaded); dispatch({ type: "phase", phase: "video_downloaded", message: outputPath, jobId: remote.id });
    await retryImport(videoDownloaded);
  }

  async function retryImport(pending: PersistedJob) {
    if (!pending.metadata) throw new Error("Generation metadata is unavailable for Retry import.");
    const completed = await importDownloadedResult(pending, pending.metadata, {
      host,
      onPhase: (phase) => dispatch({ type: "phase", phase, jobId: pending.jobId }),
      onUpdate: (updated) => { savePendingJob(updated); setDetails(updated); }
    });
    const phase = completed.status === "completed_with_warning" ? "completed_with_warning" : completed.status === "completed" ? "completed" : "failed";
    dispatch({ type: "phase", phase, message: completed.warning ?? completed.outputPath, jobId: completed.jobId });
  }

  return <main>
    <section><h2>Connection</h2><label className="field"><span>Server URL</span><input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} /></label><div className={connected ? "status ok" : "status error"}>SnarkRoute server: {connecting ? "connecting…" : connected ? "connected" : "disconnected"}</div><div className="diagnostics" aria-label="Connection diagnostics"><div>URL: {connection?.url ?? `${serverUrl.replace(/\/$/, "")}/health`}</div><div>Last attempt: {connection?.attemptedAt ?? "not attempted"}</div><div>Status: {connection?.status ?? "n/a"}</div><div>Runtime origin: {typeof window === "undefined" ? "n/a" : window.location.origin}</div>{connection?.responseBody && <div>Response: {connection.responseBody.slice(0, 300)}</div>}{connection?.error && <div className="error-text">Error: {connection.error}</div>}</div><button onClick={() => void connect()} disabled={connecting}>Reconnect</button></section>
    <section><h2>Operation</h2><select value="image-to-video" disabled><option>Image to video</option></select><small>Available operations follow the executable model catalog.</small></section>
    <section><h2>Source</h2><select value="current-frame" disabled><option>Current composition frame</option></select><small>Selected footage and work-area video follow after the MVP vertical slice.</small></section>
    <section><h2>Model</h2><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.provider}{model.originVendor ? ` / ${model.originVendor}` : ""}</option>)}</select>{selectedModel && <><small>{selectedModel.availability.status}{selectedModel.pricing ? ` · pricing ${selectedModel.pricing.status ?? "available"}${selectedModel.pricing.currency ? ` (${selectedModel.pricing.currency})` : ""}` : " · catalog price unavailable"}</small><div className="diagnostics"><div>Input model contract:</div><div>Required images: {selectedModel.requiredImageInputs ?? 0}</div><div>Maximum images: {selectedModel.maximumImageInputs ?? "unknown"}</div><div>Images supplied: 1</div></div></>}{connected && <div className="diagnostics"><div>Executable models: {models.length}</div><div>Families: {countModelFamilies(models)}</div>{countModelFamilies(models) === 1 && <div>Catalog filtering diagnostics available: {modelDiagnosticsUrl}</div>}</div>}{!models.length && connected && <small>No configured image-to-video models are available.</small>}</section>
    <section><h2>Prompt</h2><textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the motion and scene" /></section>
    {selectedModel && <section><h2>Parameters</h2><ParameterFields fields={selectedModel.parameters} values={parameters} onChange={(id, value) => setParameters((current) => ({ ...current, [id]: value }))} /><button className="link" onClick={() => setAdvancedOpen((value) => !value)}>Advanced parameters {advancedOpen ? "▴" : "▾"}</button>{advancedOpen && <ParameterFields advanced fields={selectedModel.parameters} values={parameters} onChange={(id, value) => setParameters((current) => ({ ...current, [id]: value }))} />}</section>}
    <section><h2>Quote</h2><div>{quote}</div><button onClick={() => void updateQuote()} disabled={!selectedModel}>Refresh quote</button></section>
    <section><button className="primary" onClick={() => void generate()} disabled={!connected || !selectedModel || ["preparing input", "uploading", "queued", "running", "downloading", "importing_result", "organizing_project_items", "replacing_layer_source", "writing_metadata"].includes(job.phase)}>Generate</button></section>
    <section><h2>Current job</h2><div className={`status ${job.phase === "failed" ? "error" : ""}`}>{job.phase}{job.message ? ` · ${job.message}` : ""}</div>{(exportDiagnostic ?? details?.inputFrameExport) && <ExportDiagnostics diagnostic={(exportDiagnostic ?? details?.inputFrameExport)!} />}{details?.inputFramePath && <><div className="diagnostics"><div>Input frame:</div><div>{details.inputFramePath}</div><div>Asset: {details.inputAssetId}</div><div>Source: {details.sourceCompositionName} ({details.sourceCompositionId}) at {details.sourceTime}</div></div><button onClick={() => void host.revealFile(details.inputFramePath)}>Reveal input frame</button><button onClick={() => void host.openFile(details.inputFramePath)}>Open input frame</button></>}</section>
    {details?.outputPath && <section><h2>Result import</h2><div className="diagnostics"><div>Result: {details.outputPath}</div><div>Imported footage: {details.importedFootage?.importedItemName ?? "not imported"}</div><div>Project folder: {details.importedFootage?.projectFolderName ?? "n/a"}</div><div>Layer source replaced: {details.layerReplacement?.sourceReplaced ? "yes" : "no"}</div>{details.importedFootage?.importError && <div>Error: {details.importedFootage.importError}</div>}{details.layerReplacement?.replaceSourceError && <div>Error: {details.layerReplacement.replaceSourceError}</div>}</div>{details.status === "failed" && <button onClick={() => void retryImport(details)}>Retry import</button>}<button onClick={() => void host.revealFile(details.outputPath)}>Reveal output file</button>{details.importedFootage?.importedItemId && <button onClick={() => void host.revealProjectItem(details.importedFootage!.importedItemId!)}>Reveal in Project</button>}<button onClick={() => void copyText(JSON.stringify({ importedFootage: details.importedFootage, layerReplacement: details.layerReplacement }, null, 2))}>Copy diagnostics</button></section>}
    {(details?.status === "completed" || details?.status === "completed_with_warning") && <section><h2>Generation details</h2><div>{details.jobId}</div><div>{details.modelId}</div><button onClick={() => void generate()}>Regenerate</button><button onClick={() => { clearPendingJob(); setDetails(null); dispatch({ type: "reset" }); }}>Clear</button></section>}
    <footer>Build: {__SNARKROUTE_BUILD_ID__}</footer>
  </main>;
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function joinPath(directory: string, filename: string) { return `${directory.replace(/[\\\/]$/, "")}\\${filename.replace(/[\\/:*?"<>|]/g, "_")}`; }
async function copyText(value: string) { if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value); const area = document.createElement("textarea"); area.value = value; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }

function ExportDiagnostics({ diagnostic }: { diagnostic: FrameExportDiagnostic }) {
  return <div className="diagnostics" aria-label="Input frame export diagnostics"><div>Stage: {diagnostic.stage}</div><div>Export method: {diagnostic.exportMethod}</div><div>Path: {diagnostic.path}</div><div>Attempts: {diagnostic.attempts}</div><div>Waited: {diagnostic.waitedMs} ms</div><div>Final size: {diagnostic.size} bytes</div><div>File.error: {diagnostic.fileError || "none"}</div></div>;
}
