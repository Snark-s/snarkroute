import { useEffect, useState } from "react";
import { apiBase } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";

type Asset = { slot: string; kind: string; path: string; filename: string; mimeType: string };
type Model = { id: string; display_name: string; group: string; verification: string; native_scale: number; context_frames: number; recommended_chunk_size: number; recommended_overlap_frames: number; license: string; commercial_use: boolean | null; weights_installed: boolean };
type Catalog = { models: Model[]; profile: Record<string, unknown>; description: string; runtimeInstalled: boolean; resourcePolicy: { minFreeVramMiB: number; minAvailableRamMiB: number } };
export type VideoUpscaleDraft = { id?: string; title: string; assets: Asset[]; videoUpscale?: Record<string, unknown> };
const DEFAULT_MODEL = "openmodeldb/vimeoscale-unet-x2";

export function buildVideoUpscaleQueueRequest(source: Asset, settings: Record<string, unknown>, title = "Video Upscale") {
  return { title: title.trim() || "Video Upscale", operation: "video_upscale", prompt: "", variants: 1, assets: [{ ...source, slot: "sourceVideo", kind: "video" }], videoUpscale: settings };
}

export function VideoUpscaleComposer({ onQueued, draft, onClearDraft, outputs = [] }: { onQueued: () => Promise<void>; draft?: VideoUpscaleDraft; onClearDraft: () => void; outputs?: string[] }) {
  const [catalog,setCatalog] = useState<Catalog>();
  const [settings,setSettings] = useState<Record<string, unknown>>({});
  const [source,setSource] = useState<Asset>();
  const [title,setTitle] = useState("Video Upscale");
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const [dimensions,setDimensions] = useState<[number,number]>();
  useEffect(() => {
    let disposed = false;
    void apiFetch(`${apiBase}/api/h3/video-upscale`).then(async response => {
      if (!response.ok) throw new Error("Video Upscale catalog is unavailable.");
      const data = await response.json() as Catalog;
      if (!disposed) { setCatalog(data); setSettings(draft?.videoUpscale ?? data.profile); }
    }).catch(error => { if (!disposed) setMessage(String(error)); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (draft) { setSource(draft.assets[0]); setTitle(draft.title); setSettings(draft.videoUpscale ?? catalog?.profile ?? {}); }
    else { setSource(undefined); setTitle("Video Upscale"); if (catalog) setSettings(catalog.profile); }
    setDimensions(undefined);
  }, [draft]);
  const selected = catalog?.models.find(m => m.id === (settings.model ?? DEFAULT_MODEL));
  function change(key: string,value: unknown) { setSettings(current => ({ ...current,[key]: value })); }
  async function upload(file: File) {
    setBusy(true); setMessage("");
    try {
      const dataBase64 = await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = reject; reader.readAsDataURL(file); });
      const response = await apiFetch(`${apiBase}/api/assets/import`,{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name,dataBase64,kind: "video" }) });
      const asset = await response.json();
      if (!response.ok || !asset.path || !asset.metadata?.mimeType) throw new Error(asset.error ?? "Video import failed.");
      setSource({ slot: "sourceVideo",kind: "video",path: asset.path,filename: file.name,mimeType: asset.metadata.mimeType }); setDimensions(undefined);
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }
  async function enqueue() {
    if (!source) return;
    setBusy(true); setMessage("");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/queue${draft?.id ? `/${draft.id}` : ""}`,{ method: draft?.id ? "PUT" : "POST",headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildVideoUpscaleQueueRequest(source,settings,title)) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not add Video Upscale to Queue.");
      await onQueued(); onClearDraft(); setMessage("Video Upscale added to Queue. Select it and run on Local GPU.");
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }
  return <section className="h3ComposerSection h3VideoUpscale" aria-label="Video Upscale">
    <header className="h3QueueHeader"><div><span className="h3Eyebrow">VIDEO UPSCALE</span><h2>Video Upscale</h2><p>Conservative temporal enlargement preserving motion and appearance.</p></div></header>
    <div className="h3ComposerLayout"><div className="h3ComposerMain">
      <strong>{selected?.display_name ?? "VimeoScale 2× — Conservative Video"} {settings.model === DEFAULT_MODEL ? "· default" : ""}</strong>
      <p>{selected?.verification ?? "Verified · H3 Max / CUDA / 2× tested"} · {selected?.license ?? "CC-BY-SA-4.0"}{selected?.commercial_use === false ? " · NONCOMMERCIAL" : ""}</p>
      <label><span>Input video</span><input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} /></label>
      {outputs.length ? <label><span>Or use a Queue result</span><select value="" disabled={busy} onChange={event => { const path = event.target.value; if (path) { setSource({ slot: "sourceVideo",kind: "video",path,filename: path.split(/[\\/]/).pop() ?? "result.mp4",mimeType: "video/mp4" }); setDimensions(undefined); } }}><option value="">Choose video…</option>{outputs.map(path => <option key={path} value={path}>{path.split(/[\\/]/).pop()}</option>)}</select></label> : null}
      {source ? <div><p>{source.filename}</p><video className="h3UpscalePreview" key={source.path} src={`${apiBase}/api/assets/preview?kind=video&path=${encodeURIComponent(source.path)}`} controls preload="metadata" onLoadedMetadata={event => setDimensions([event.currentTarget.videoWidth,event.currentTarget.videoHeight])} /></div> : null}
      <label><span>Output</span><select value={settings.delivery ? (settings.delivery as number[]).join("x") : "native"} onChange={event => change("delivery",event.target.value === "native" ? undefined : event.target.value.split("x").map(Number))}><option value="native">Native {selected?.native_scale ?? 2}×</option><option value="2560x1440">Delivery · 2560×1440 canvas</option><option value="1920x1080">Delivery · 1920×1080 canvas</option><option value="1440x2560">Delivery · 1440×2560 portrait canvas</option></select></label>
      {dimensions ? <p>Source {dimensions.join("×")} → native {dimensions.map(n => n*(selected?.native_scale ?? 2)).join("×")}{settings.delivery ? ` → ${(settings.delivery as number[]).join("×")} delivery · fit + black padding` : ""}</p> : null}
      <p>Audio: {settings.audio_handling === "aac" ? "AAC re-encode explicitly selected" : settings.audio_handling === "drop" ? "Drop explicitly selected" : "Preserve original · stream copy"} · Device: Local GPU</p>
      <button className="h3Primary" type="button" disabled={busy || !source || !catalog} onClick={() => void enqueue()}>{busy ? "Working…" : draft?.id ? "Save Queue item" : "Add to Queue"}</button>
      {draft ? <button type="button" onClick={onClearDraft}>Cancel editing</button> : null}
      {message ? <p className="h3QueueMessage" role="status">{message}</p> : null}
    </div><aside className="h3ComposerSettings"><details><summary>Advanced settings</summary>
      <button type="button" onClick={() => { if (catalog) setSettings(catalog.profile); }}>Use Vimeo production profile</button>
      <label><span>Model</span><select value={String(settings.model ?? DEFAULT_MODEL)} onChange={event => { const model = catalog?.models.find(m => m.id === event.target.value); if (model) setSettings(current => ({ ...catalog?.profile,...current,model: model.id,scale: model.native_scale,context: model.context_frames,chunk_size: model.id === DEFAULT_MODEL ? 3 : model.recommended_chunk_size,overlap_frames: model.recommended_overlap_frames })); }}>{["Production","Experimental"].map(group => <optgroup label={group === "Experimental" ? "Experimental Models · Manual" : group} key={group}>{catalog?.models.filter(m => m.group === group).map(m => <option key={m.id} value={m.id}>{m.display_name}{m.commercial_use === false ? " · NONCOMMERCIAL" : ""}</option>)}</optgroup>)}</select></label>
      <p>Native scale {selected?.native_scale ?? 2}× · context {selected?.context_frames ?? 3} frames · {selected?.weights_installed ? "Weights installed" : "Weights not installed"}</p>
      <label><span>Title</span><input value={title} onChange={event => setTitle(event.target.value)} /></label>
      {([['chunk_size','Chunk size',1,120],['overlap_frames','Overlap frames',0,16],['crf','CRF',0,51],['gop','GOP',1,600]] as const).map(([key,label,min,max]) => <label key={key}><span>{label}</span><input type="number" min={min} max={max} value={Number(settings[key] ?? catalog?.profile[key] ?? min)} onChange={event => change(key,Number(event.target.value))} /></label>)}
      <label><span>Preset</span><select value={String(settings.preset ?? "medium")} onChange={event => change("preset",event.target.value)}>{["fast","medium","slow"].map(preset => <option key={preset}>{preset}</option>)}</select></label>
      <label><span>Audio handling</span><select value={String(settings.audio_handling ?? "copy")} onChange={event => change("audio_handling",event.target.value)}><option value="copy">Preserve original · copy</option><option value="aac">AAC re-encode · explicit</option><option value="drop">Drop audio</option></select></label>
      <p>H.264 / libx264 · MP4 · CUDA only · source CFR timing</p><p>Color: explicit SDR BT.709 decode → RGB → encode. Untagged sources are logged as BT.709 SDR assumed; output tags are verified.</p>
      <p>Aspect: fit inside the delivery canvas, pad as needed; no crop. Dimensions round to even pixels. SAR=1.</p>
      <p>Resource precheck: free VRAM ≥ {catalog?.resourcePolicy.minFreeVramMiB ?? 8192} MiB; available RAM ≥ {catalog?.resourcePolicy.minAvailableRamMiB ?? 4096} MiB. One local upscale at a time. {catalog?.runtimeInstalled ? "Runtime installed." : "Runtime not installed."}</p>
    </details></aside></div>
  </section>;
}
