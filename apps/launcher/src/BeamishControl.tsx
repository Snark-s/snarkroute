import { LoaderCircle, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";

// Snark’s Imaginarium (creative agent Beamish): a separate project next to SnarkRoute.
// The SnarkRoute API starts it on demand and stops it through Imaginarium's own shutdown.
type BeamishStatus = { ok: boolean; url: string; status: "stopped" | "starting" | "ready" | "error"; running: boolean; error?: string };

const LABELS: Record<BeamishStatus["status"], string> = { ready: "работает", starting: "запускается", stopped: "остановлен", error: "ошибка" };

async function call(apiBase: string, path: string, init?: RequestInit): Promise<BeamishStatus> {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json() as BeamishStatus;
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function BeamishControl({ apiBase, logAlert = false }: { apiBase: string; logAlert?: boolean }) {
  const [state, setState] = useState<BeamishStatus>();
  const [action, setAction] = useState<"start" | "stop" | "">("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await call(apiBase, "/api/system/apps/beamish/status", { signal: AbortSignal.timeout(3000) });
        if (!disposed) { setState(next); setError(next.error ?? ""); }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Статус Бимиша недоступен");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [apiBase]);

  async function change(next: "start" | "stop") {
    setAction(next);
    setError("");
    try {
      const path = next === "start" ? "/api/system/apps/beamish/open" : "/api/system/apps/beamish/stop";
      await call(apiBase, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(60_000) });
      setState(await call(apiBase, "/api/system/apps/beamish/status"));
      window.dispatchEvent(new Event("snarkroute:apps-changed")); // the app card shows the new state too
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить состояние Бимиша");
    } finally {
      setAction("");
    }
  }

  const status = state?.status ?? "stopped";
  const working = Boolean(action) || status === "starting";
  const nextAction: "start" | "stop" = state?.running ? "stop" : "start";
  const actionLabel = nextAction === "stop" ? "Остановить" : "Запустить";
  const label = state ? LABELS[status] : "проверка…";
  return <span className={`runtimeMini ${state ? status : ""}`} title={`${error || `Бимиш · Snark’s Imaginarium: ${label}${state?.url ? ` · ${state.url}` : ""}`} · правый клик: терминал`} data-service-id="beamish" data-service-label="Beamish" data-log-alert={logAlert || undefined}>
    <span className="runtimeMiniDot" />
    <span>Beamish</span>
    <button type="button" aria-label={`${actionLabel} Бимиша`} title={`${actionLabel} Бимиша (Snark’s Imaginarium)`} disabled={!state || working || status === "error"} onClick={() => void change(nextAction)}>
      {working ? <LoaderCircle className="spin" /> : nextAction === "stop" ? <Square /> : <Play />}
    </button>
  </span>;
}
