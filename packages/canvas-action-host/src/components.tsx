import { Panorama360Viewer, SplatViewer } from "@snarkroute/media-viewers";
import { useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
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
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [clipboardError, setClipboardError] = useState<string>();
  if (inputType === "text") return <textarea className="canvasActionTextInput" value={input.kind === "text" ? input.text : ""} placeholder="Enter text" onChange={(event) => onChange({ kind: "text", type: "text", text: event.target.value })} />;
  const accept = `${inputType}/*`;
  const select = (file?: File) => {
    if (!file) return;
    setClipboardError(undefined);
    onChange({ kind: "file", type: inputType, file, previewUrl: URL.createObjectURL(file) });
  };
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); select(event.dataTransfer.files[0]); };
  const pasteImage = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
      setClipboardError("Clipboard image access is not supported by this browser.");
      return;
    }
    setClipboardBusy(true);
    setClipboardError(undefined);
    try {
      const file = await readClipboardImage(navigator.clipboard);
      if (file) select(file);
      else setClipboardError("The clipboard does not contain an image.");
    } catch {
      setClipboardError("Could not read the clipboard. Allow clipboard access and try again.");
    } finally {
      setClipboardBusy(false);
    }
  };
  return <div className="canvasActionDropzone" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
    {input.kind === "file" && input.type === "image" && input.previewUrl ? <img className="canvasActionInputPreview" src={input.previewUrl} alt={input.file.name} /> : null}
    <strong>{input.kind === "file" ? input.file.name : input.kind === "empty" && input.filename ? `${input.filename} must be selected again` : `Drop ${inputType} here`}</strong>
    <span>or choose a file</span>
    <input type="file" accept={accept} onChange={(event: ChangeEvent<HTMLInputElement>) => select(event.target.files?.[0])} />
    <div className="canvasActionInputActions">
      {inputType === "image" ? <button type="button" disabled={clipboardBusy} onClick={() => void pasteImage()}>{clipboardBusy ? "Pasting…" : "Paste from clipboard"}</button> : null}
      {input.kind === "file" ? <button type="button" onClick={() => onChange({ kind: "empty", expectedType: inputType })}>Clear</button> : null}
    </div>
    {clipboardError ? <span className="canvasActionInputError" role="alert">{clipboardError}</span> : null}
  </div>;
}

export async function readClipboardImage(clipboard: Pick<Clipboard, "read">): Promise<File | null> {
  const items = await clipboard.read();
  for (const item of items) {
    const mimeType = item.types.find((type) => type.startsWith("image/"));
    if (!mimeType) continue;
    const blob = await item.getType(mimeType);
    const timestamp = Date.now();
    return new File([blob], `clipboard-${timestamp}.${clipboardImageExtension(mimeType)}`, {
      type: mimeType,
      lastModified: timestamp
    });
  }
  return null;
}

export async function copyImageUrlToClipboard(
  src: string,
  clipboard: Pick<Clipboard, "write">,
  fetchImage: typeof fetch = fetch,
  ClipboardItemClass: typeof ClipboardItem = ClipboardItem
): Promise<void> {
  const response = await fetchImage(src);
  if (!response.ok) throw new Error(`Could not load the image (${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The result is not an image.");
  await clipboard.write([new ClipboardItemClass({ [blob.type]: blob })]);
}

function clipboardImageExtension(mimeType: string): string {
  const subtype = mimeType.slice("image/".length).toLowerCase();
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  if (subtype === "x-icon" || subtype === "vnd.microsoft.icon") return "ico";
  return subtype.split("+")[0]?.replace(/[^a-z0-9]/g, "") || "image";
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
  const [copyStatus, setCopyStatus] = useState<Record<string, "copying" | "copied" | "error">>({});
  const copyImage = async (result: ToolResult) => {
    if (!result.url) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      setCopyStatus((current) => ({ ...current, [result.id]: "error" }));
      return;
    }
    setCopyStatus((current) => ({ ...current, [result.id]: "copying" }));
    try {
      await copyImageUrlToClipboard(result.url, navigator.clipboard);
      setCopyStatus((current) => ({ ...current, [result.id]: "copied" }));
    } catch {
      setCopyStatus((current) => ({ ...current, [result.id]: "error" }));
    }
  };
  return <div className="canvasActionOutputs">{results.map((result) => <article key={result.id} className="canvasActionResult">
    <header>
      <strong>{result.label}</strong>
      {result.url ? <div className="canvasActionResultActions">
        {result.type === "image" ? <button
          className="canvasActionResultButton"
          type="button"
          disabled={copyStatus[result.id] === "copying"}
          title={copyStatus[result.id] === "error" ? "Could not copy the image. Allow clipboard access and try again." : "Copy image to clipboard"}
          onClick={() => void copyImage(result)}
        >
          {copyStatus[result.id] === "copying" ? "Copying…" : copyStatus[result.id] === "copied" ? "Copied" : copyStatus[result.id] === "error" ? "Copy failed" : "Copy image"}
        </button> : null}
        <a className="canvasActionResultButton" href={result.url} download={result.filename}>Download</a>
      </div> : null}
    </header>
    {result.text !== undefined ? <pre>{result.text}</pre> : result.url ? <CanvasActionPreview kind={result.type} src={result.url} title={result.label} /> : <pre>{JSON.stringify(result.value, null, 2)}</pre>}
  </article>)}</div>;
}

export function CanvasActionHost({ action, tab, onChange, onRun, header }: { action: CanvasNodeAction; tab: ToolTabState; onChange: (tab: ToolTabState) => void; onRun: () => void; header?: ReactNode }) {
  const actionInputs = action.inputs?.length ? action.inputs : [{ id: "input", type: action.inputType, label: "Input" }];
  const firstInput = tab.inputs[actionInputs[0]?.id ?? ""];
  const inputPreview = firstInput?.kind === "file" ? firstInput.previewUrl : undefined;
  const manifestPreview = action.dialog?.preview?.[0];
  const outputPreviewId = manifestPreview?.source !== "input" && manifestPreview?.source && "output" in manifestPreview.source ? manifestPreview.source.output : undefined;
  const outputPreview = outputPreviewId ? tab.results.find((result) => result.outputId === outputPreviewId)?.url : undefined;
  const prepared = tab.preparedPreviews?.[0];
  const preview = prepared ?? (manifestPreview && manifestPreview.source === "input" && inputPreview ? { kind: manifestPreview.kind, src: inputPreview } : outputPreview && manifestPreview ? { kind: manifestPreview.kind, src: outputPreview } : undefined);
  return <main className="canvasActionHost">
    {header}
    <section><h2>Inputs</h2>{actionInputs.map((port) => (
      <div className="canvasActionInputField" key={port.id}>
        <label>{port.label ?? port.id} <small>{port.type}</small></label>
        <CanvasActionInput
          input={tab.inputs[port.id] ?? (port.type === "text" ? { kind: "text", type: "text", text: "" } : { kind: "empty", expectedType: port.type })}
          inputType={port.type}
          onChange={(input) => onChange({ ...tab, inputs: { ...tab.inputs, [port.id]: input }, error: undefined })}
        />
      </div>
    ))}</section>
    {visibleCanvasActionParams(action).length ? <section><h2>Parameters</h2><CanvasActionParamForm action={action} values={tab.params} onChange={(params) => onChange({ ...tab, params })} /></section> : null}
    {preview ? <section><h2>Preview</h2><CanvasActionPreview kind={preview.kind} src={preview.src} title={action.title} /></section> : null}
    <div className="canvasActionRunBar"><button type="button" disabled={tab.status === "running" || actionInputs.some((port) => tab.inputs[port.id]?.kind === "empty" || !tab.inputs[port.id])} onClick={onRun}>{tab.status === "paused" ? "Continue" : tab.status === "running" ? "Running…" : tab.results.length ? "Run again" : "Run"}</button><span>{tab.status}</span></div>
    {tab.error ? <div className="canvasActionError" role="alert">{tab.error}</div> : null}
    {tab.results.length ? <section><h2>Results</h2><CanvasActionOutputs results={tab.results} /></section> : null}
  </main>;
}
