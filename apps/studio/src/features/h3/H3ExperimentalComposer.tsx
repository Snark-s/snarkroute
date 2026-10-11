import { useState } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { apiBase } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";

export function H3ExperimentalComposer() {
  const [mode, setMode] = useState<"still" | "x2">("still");
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ratio, setRatio] = useState("16:9");
  const [reference, setReference] = useState<File | null>(null);
  async function enqueue() {
    if (!prompt.trim() || busy) return;
    setBusy(true); setMessage("");
    try {
      const still = mode === "still";
      const assets: Array<{ slot: "referenceImage"; kind: "image"; path: string; filename: string; mimeType: string }> = [];
      if (still && reference) {
        const bytes = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error("Не удалось прочитать референс"));
          reader.readAsDataURL(reference);
        });
        const up = await apiFetch(`${apiBase}/api/assets/import`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: reference.name, dataBase64: bytes, kind: "image" })
        });
        const file = await up.json() as { path?: string; metadata?: { mimeType?: string }; error?: string };
        if (!up.ok || !file.path || !file.metadata?.mimeType) throw new Error(file.error ?? "Ошибка загрузки референса");
        assets.push({ slot: "referenceImage", kind: "image", path: file.path, filename: reference.name, mimeType: file.metadata.mimeType });
      }
      const result = await apiFetch(`${apiBase}/api/h3/queue`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: still ? "H3 Fizgig Still" : "H3 X2 VAE Video",
          operation: still ? "still_image" : "text_to_video",
          prompt: prompt.trim(), duration: still ? 4 : 5,
          aspectRatio: ratio, variants: 1, renderMode: "preview",
          modelVariant: "h3_base", inferenceSteps: 4,
          vaeMode: still ? "stock" : "x2", assets
        })
      });
      const body = await result.json() as { error?: string };
      if (!result.ok) throw new Error(body.error ?? "Ошибка добавления в очередь");
      setMessage("Задача добавлена в очередь H3.");
      setPrompt("");
      setReference(null);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="h3ComposerSection">
    <header className="h3QueueHeader"><div><span className="h3Eyebrow">LOCAL H3 · EXPERIMENT</span>
      <h2><Sparkles size={17} /> Fizgig Still / X2 VAE</h2><p>Эксперимент: Fizgig создаёт PNG в локальном разрешении Preview (960×544); X2 удваивает ширину и высоту видео. B32 Detail Enhancement пока не подключён. Исходный режим H3 не меняется.</p></div><button className="h3SectionToggle" type="button" aria-label="Развернуть экспериментальные режимы H3" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></header>
    {expanded ? <div className="h3ComposerLayout"><div className="h3ComposerMain">
      <label>Режим<select value={mode} onChange={e => setMode(e.target.value as "still" | "x2")}>
        <option value="still">Fizgig: один кадр PNG</option><option value="x2">X2: видео с двойным разрешением</option>
      </select></label>
      <label>Промпт<textarea rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      {mode === "still" ? <label>Референс для редактирования (необязательно)<input type="file" accept="image/png,image/jpeg" onChange={e => setReference(e.target.files?.[0] ?? null)} /></label> : null}
    </div><aside className="h3ComposerSettings">
      <label>Соотношение сторон<select value={ratio} onChange={e => setRatio(e.target.value)}>
        {["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"].map(v => <option key={v}>{v}</option>)}
      </select></label>
      <button type="button" disabled={busy || !prompt.trim()} onClick={() => void enqueue()}>
        <Sparkles size={15} /> Добавить в очередь
      </button>
      {message ? <p role="status">{message}</p> : null}
    </aside></div> : null}
  </section>;
}
