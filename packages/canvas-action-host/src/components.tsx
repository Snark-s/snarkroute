import { Panorama360Viewer, SplatViewer } from "@snarkroute/media-viewers";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import type { CanvasActionParam, CanvasActionPreviewKind, CanvasNodeAction, ToolInputState, ToolResult, ToolTabState } from "./model.js";
import { visibleCanvasActionParams } from "./model.js";

export function CanvasActionParamForm({ action, values, onChange }: { action: CanvasNodeAction; values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void }) {
  return <div className="canvasActionParamForm">{visibleCanvasActionParams(action).map((param) => (
    <label key={param.id} className="canvasActionParam">
      <span>{param.label ?? param.id}</span>
      {param.description ? <small>{param.description}</small> : null}
      <ParamInput param={param} value={values[param.id]} onChange={(value) => onChange({ ...values, [param.id]: value })} />
    </label>
  ))}</div>;
}

function ParamInput({ param, value, onChange }: { param: CanvasActionParam; value: unknown; onChange: (value: unknown) => void }) {
  if (param.type === "boolean") return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />;
  if (param.options?.length) return <select value={String(value ?? "")} onChange={(event) => onChange(param.options?.find((option) => String(option.value) === event.target.value)?.value ?? event.target.value)}>{param.options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label ?? String(option.value)}</option>)}</select>;
  if (param.type === "number" || param.type === "integer") return <input type="number" value={typeof value === "number" ? value : ""} min={param.min} max={param.max} step={param.step ?? (param.type === "integer" ? 1 : "any")} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />;
  return <input type="text" value={typeof value === "string" ? value : JSON.stringify(value ?? "")} onChange={(event) => onChange(event.target.value)} />;
}

export function CanvasActionInput({ input, inputType, onChange }: { input: ToolInputState; inputType: CanvasNodeAction["inputType"]; onChange: (input: ToolInputState) => void }) {
  if (inputType === "text") return <textarea className="canvasActionTextInput" value={input.kind === "text" ? input.text : ""} placeholder="Enter text" onChange={(event) => onChange({ kind: "text", type: "text", text: event.target.value })} />;
  const accept = `${inputType}/*`;
  const select = (file?: File) => file && onChange({ kind: "file", type: inputType, file, previewUrl: URL.createObjectURL(file) });
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); select(event.dataTransfer.files[0]); };
  return <div className="canvasActionDropzone" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
    <strong>{input.kind === "file" ? input.file.name : input.kind === "empty" && input.filename ? `${input.filename} must be selected again` : `Drop ${inputType} here`}</strong>
    <span>or choose a file</span>
    <input type="file" accept={accept} onChange={(event: ChangeEvent<HTMLInputElement>) => select(event.target.files?.[0])} />
    {input.kind === "file" ? <button type="button" onClick={() => onChange({ kind: "empty", expectedType: inputType })}>Clear</button> : null}
  </div>;
}

export function CanvasActionPreview({ kind, src, title }: { kind: CanvasActionPreviewKind; src: string; title: string }) {
  if (kind === "image") return <img className="canvasActionPreview" src={src} alt={title} />;
  if (kind === "video") return <video className="canvasActionPreview" src={src} controls />;
  if (kind === "audio") return <audio className="canvasActionAudio" src={src} controls />;
  if (kind === "panorama360") return <Panorama360Viewer src={src} title={title} className="canvasActionInteractivePreview" canvasClassName="canvasActionPreviewCanvas" />;
  if (kind === "splat") return <SplatViewer splatUrl={src} className="canvasActionInteractivePreview" mountClassName="canvasActionSplatMount" canvasClassName="canvasActionPreviewCanvas" />;
  return null;
}

export function CanvasActionOutputs({ results }: { results: ToolResult[] }) {
  return <div className="canvasActionOutputs">{results.map((result) => <article key={result.id} className="canvasActionResult">
    <header><strong>{result.label}</strong>{result.url ? <a href={result.url} download={result.filename}>Download</a> : null}</header>
    {result.text !== undefined ? <pre>{result.text}</pre> : result.url ? <CanvasActionPreview kind={result.type} src={result.url} title={result.label} /> : <pre>{JSON.stringify(result.value, null, 2)}</pre>}
  </article>)}</div>;
}

export function CanvasActionHost({ action, tab, onChange, onRun, header }: { action: CanvasNodeAction; tab: ToolTabState; onChange: (tab: ToolTabState) => void; onRun: () => void; header?: ReactNode }) {
  const inputPreview = tab.input.kind === "file" ? tab.input.previewUrl : undefined;
  const manifestPreview = action.dialog?.preview?.[0];
  const outputPreviewId = manifestPreview?.source !== "input" && manifestPreview?.source && "output" in manifestPreview.source ? manifestPreview.source.output : undefined;
  const outputPreview = outputPreviewId ? tab.results.find((result) => result.outputId === outputPreviewId)?.url : undefined;
  const prepared = tab.preparedPreviews?.[0];
  const preview = prepared ?? (manifestPreview && manifestPreview.source === "input" && inputPreview ? { kind: manifestPreview.kind, src: inputPreview } : outputPreview && manifestPreview ? { kind: manifestPreview.kind, src: outputPreview } : undefined);
  return <main className="canvasActionHost">
    {header}
    <section><h2>Input</h2><CanvasActionInput input={tab.input} inputType={action.inputType} onChange={(input) => onChange({ ...tab, input, error: undefined })} /></section>
    {visibleCanvasActionParams(action).length ? <section><h2>Parameters</h2><CanvasActionParamForm action={action} values={tab.params} onChange={(params) => onChange({ ...tab, params })} /></section> : null}
    {preview ? <section><h2>Preview</h2><CanvasActionPreview kind={preview.kind} src={preview.src} title={action.title} /></section> : null}
    <div className="canvasActionRunBar"><button type="button" disabled={tab.status === "running" || tab.input.kind === "empty"} onClick={onRun}>{tab.status === "paused" ? "Continue" : tab.status === "running" ? "Running…" : tab.results.length ? "Run again" : "Run"}</button><span>{tab.status}</span></div>
    {tab.error ? <div className="canvasActionError" role="alert">{tab.error}</div> : null}
    {tab.results.length ? <section><h2>Results</h2><CanvasActionOutputs results={tab.results} /></section> : null}
  </main>;
}
