import { ArrowUpRight, LoaderCircle, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";

// Tove (Шорёк) and Factory (Фабрика) run as independent background processes next to SnarkRoute.
// The card shows their own health state; closing the Мастерская does not stop them.
export type AutonomousState = "stopped" | "starting" | "ready" | "working" | "paused" | "paused_gpu" | "error" | "stopping" | "unavailable";
export type AutonomousStatus = { ok?: boolean; id: string; state: AutonomousState; running: boolean; url: string; mode?: string; current?: { title?: string } | null; error?: string };
type CardApp = { id: string; name: string; description: string; accent: string; icon: string; url: string };

export const AUTONOMOUS_LABELS: Record<AutonomousState, string> = {
  stopped: "остановлен", starting: "запускается", ready: "готов", working: "работает", paused: "пауза",
  paused_gpu: "пауза GPU", error: "ошибка", stopping: "останавливается", unavailable: "недоступен"
};

async function call(apiBase: string, path: string, init?: RequestInit): Promise<AutonomousStatus & { url: string }> {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json() as AutonomousStatus & { ok: boolean; error?: string };
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function AutonomousAppCard({ app, apiBase, index }: { app: CardApp; apiBase: string; index: number }) {
  const [status, setStatus] = useState<AutonomousStatus>();
  const [action, setAction] = useState<"start" | "stop" | "open" | "">("");
  const [error, setError] = useState("");
  const [icon, setIcon] = useState(app.id === "tove" ? `${app.url}/assets/tove-avatar.png` : app.icon);

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await call(apiBase, `/api/system/apps/${app.id}/status`, { signal: AbortSignal.timeout(4000) });
        if (!disposed) { setStatus(next); setError(next.error ?? ""); }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Статус недоступен");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [apiBase, app.id]);

  async function change(next: "start" | "stop") {
    if (action) return; // one operation at a time; the server also refuses duplicate starts
    setAction(next); setError("");
    try {
      setStatus(await call(apiBase, `/api/system/apps/${app.id}/${next}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(70_000) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить состояние");
    } finally { setAction(""); }
  }

  async function open() {
    if (action) return;
    setAction("open"); setError("");
    const popup = window.open("about:blank", `snarkroute-${app.id}`);
    try {
      const result = await call(apiBase, `/api/system/apps/${app.id}/open`, { method: "POST", signal: AbortSignal.timeout(70_000) });
      if (popup) popup.location.href = result.url; else location.href = result.url;
    } catch (reason) {
      popup?.close(); setError(reason instanceof Error ? reason.message : "Не удалось открыть");
    } finally { setAction(""); }
  }

  const state: AutonomousState = status?.state ?? "stopped";
  const busy = Boolean(action) || state === "starting" || state === "stopping";
  const live = ["ready", "working", "paused", "paused_gpu"].includes(state);
  const label = status ? AUTONOMOUS_LABELS[state] : "проверка…";
  const detail = error || (status?.current?.title ? `сейчас: ${status.current.title}` : status?.mode && status.mode !== "run" ? `режим: ${status.mode}` : "");
  return <div className={`appCard ${app.accent} autonomousCard`} style={{ animationDelay: `${index * 55}ms` }}>
    <button className="cardMain" onClick={() => void open()} disabled={busy || state === "unavailable"} title={error || `Открыть: ${app.name}`}>
      <span className="cardGlow" />
      <span className="appIcon branded"><img src={icon} alt="" onError={() => setIcon(app.icon)} /></span>
      <span className="appCopy"><strong>{app.name}</strong><small>{app.description}</small></span>
      <span className="cardFooter">
        <span className={`status autonomous ${state}`}><span className="autonomousDot" />{label}</span>
        {action === "open" ? <LoaderCircle className="spin" /> : <ArrowUpRight />}
      </span>
      {detail ? <span className="autonomousDetail">{detail}</span> : null}
    </button>
    <span className="cardActions">
      {live || state === "stopping" || state === "error" && status?.running
        ? <button title={`Остановить: ${app.name}`} disabled={busy} onClick={() => void change("stop")}>{action === "stop" || state === "stopping" ? <LoaderCircle className="spin" /> : <Square />} Остановить</button>
        : <button title={`Запустить: ${app.name}`} disabled={busy || state === "unavailable"} onClick={() => void change("start")}>{action === "start" || state === "starting" ? <LoaderCircle className="spin" /> : <Play />} Запустить</button>}
    </span>
  </div>;
}
