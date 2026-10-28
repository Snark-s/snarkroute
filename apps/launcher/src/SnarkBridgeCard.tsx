import { FileText, LoaderCircle, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { useEffect, useState } from "react";

// SnarkBridge (ChatGPT MCP server + OpenAI tunnel). Every action goes through the SnarkRoute API:
// start/stop through the shared local runtime routes, restart and logs through /api/system/snarkbridge.
type CheckState = "ok" | "warning" | "error" | "off" | "unknown";
type Check = { state: CheckState; detail: string };
type BridgeStatus = {
  ok: boolean;
  status: "running" | "stopped" | "starting" | "stopping" | "error" | "degraded";
  summary: string;
  running: boolean;
  checks: { mcpProcess: Check; mcpEndpoint: Check; tunnel: Check; external: Check };
  control: { canStart: boolean; canStop: boolean; canRestart: boolean; blockedReason?: string };
  ownerStopped: boolean;
  operation?: { action: string; phase: string; error?: string; finishedAt?: string };
  endpoints: { mcp: string; tunnel: string };
  error?: string;
};
type LogSource = { id: string; title: string; file: string; text: string; updatedAt?: string };
type YAccess = { ok: boolean; installed: boolean; enabled: boolean; expiresAt?: string; secondsRemaining: number; durationSeconds: number; scope: string };

const STATE_LABELS: Record<BridgeStatus["status"], string> = {
  running: "Работает",
  stopped: "Остановлен",
  starting: "Запускается",
  stopping: "Останавливается",
  error: "Ошибка",
  degraded: "MCP работает · туннель отключён"
};
const CHECKS: Array<[keyof BridgeStatus["checks"], string]> = [
  ["mcpProcess", "MCP-процесс"],
  ["mcpEndpoint", "MCP endpoint"],
  ["tunnel", "Туннель"],
  ["external", "Доступ из ChatGPT"]
];

async function call<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

export function SnarkBridgeCard({ apiBase }: { apiBase: string }) {
  const [state, setState] = useState<BridgeStatus>();
  const [action, setAction] = useState<"start" | "stop" | "restart" | "">("");
  const [actionError, setActionError] = useState("");
  const [pollError, setPollError] = useState("");
  const [logs, setLogs] = useState<LogSource[]>();
  const [logsOpen, setLogsOpen] = useState(false);
  const [yAccess, setYAccess] = useState<YAccess>();
  const [accessRequest, setAccessRequest] = useState(false);
  const [accessError, setAccessError] = useState("");

  async function refresh() {
    try {
      setState(await call<BridgeStatus>(apiBase, "/api/system/snarkbridge", { signal: AbortSignal.timeout(8000) }));
      setPollError("");
    } catch (reason) {
      setPollError(reason instanceof Error ? reason.message : "Статус SnarkBridge недоступен");
    }
  }

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await call<BridgeStatus>(apiBase, "/api/system/snarkbridge", { signal: AbortSignal.timeout(8000) });
        if (!disposed) { setState(next); setPollError(""); }
      } catch (reason) {
        if (!disposed) setPollError(reason instanceof Error ? reason.message : "Статус SnarkBridge недоступен");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [apiBase]);

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await call<YAccess>(apiBase, "/api/system/snarkbridge/y-access");
        if (!disposed) setYAccess(next);
      } catch { if (!disposed) setYAccess(undefined); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [apiBase]);

  async function toggleYAccess(next: boolean) {
    setAccessRequest(true); setAccessError("");
    try {
      const action = next ? "request" : "revoke";
      await call(apiBase, `/api/system/snarkbridge/y-access/${action}`, { method: "POST" });
      setYAccess(await call<YAccess>(apiBase, "/api/system/snarkbridge/y-access"));
    } catch (reason) { setAccessError(reason instanceof Error ? reason.message : "Доступ не изменён"); }
    finally { setAccessRequest(false); }
  }

  async function loadLogs() {
    try { setLogs((await call<{ sources: LogSource[] }>(apiBase, "/api/system/snarkbridge/logs")).sources); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Журнал недоступен"); }
  }

  async function change(next: "start" | "stop" | "restart") {
    setAction(next);
    setActionError("");
    try {
      const init = { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(200_000) };
      if (next === "start") await call(apiBase, "/api/system/local-runtimes/snarkbridge/start", { ...init, body: JSON.stringify({ force: false }) });
      else if (next === "stop") await call(apiBase, "/api/system/local-runtimes/snarkbridge/stop", { ...init, body: "{}" });
      else await call(apiBase, "/api/system/snarkbridge/restart", { ...init, body: "{}" });
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Команда SnarkBridge не выполнена");
    } finally {
      setAction("");
      await refresh();
      if (logsOpen) void loadLogs();
    }
  }

  function toggleLogs() {
    const open = !logsOpen;
    setLogsOpen(open);
    if (open) void loadLogs();
  }

  const status = state?.status;
  const busy = Boolean(action) || status === "starting" || status === "stopping";
  const control = state?.control;
  const notice = actionError || pollError || control?.blockedReason || "";
  return <div className={`appCard cyan bridgeCard ${status ?? ""}`} style={{ animationDelay: "385ms" }}>
    <div className="cardMain bridgeMain">
      <span className="cardGlow" />
      <span className="bridgeHead">
        <span className="appIcon branded"><img src="/snarkbridge-icon.png" alt="" /></span>
        <span className={`bridgeBadge ${status ?? "checking"}`}>{busy ? <LoaderCircle className="spin" /> : null}{status ? STATE_LABELS[status] : "Проверка…"}</span>
      </span>
      <span className="appCopy"><strong>SnarkBridge</strong><small>{state?.summary ?? "MCP-мост для ChatGPT"}</small></span>
      <ul className="bridgeChecks">
        {CHECKS.map(([key, title]) => {
          const check = state?.checks[key];
          return <li key={key} className={check?.state ?? "unknown"} title={check?.detail}>
            <span className="bridgeDot" /><b>{title}</b><span>{check?.detail ?? "…"}</span>
          </li>;
        })}
      </ul>
      {notice ? <p className="bridgeNotice">{notice}</p> : null}
      <div className="bridgeLease" style={{position:"relative",zIndex:2,padding:"10px 0"}}>
        <label style={{display:"flex",alignItems:"center",gap:8,cursor:yAccess?.installed ? "pointer":"default"}}>
          <input type="checkbox" checked={Boolean(yAccess?.enabled)} disabled={!yAccess?.installed || accessRequest} onChange={event => void toggleYAccess(event.target.checked)} />
          <span>Расширенный доступ к Y: · 8 часов</span>
        </label>
        <small style={{display:"block",paddingTop:5,color:"var(--muted, #a2a2b5)"}}>
          {yAccess?.enabled ? `Активен ещё ${Math.floor(yAccess.secondsRemaining / 3600)} ч ${Math.floor((yAccess.secondsRemaining % 3600) / 60)} мин`
           : yAccess?.installed ? "При включении подтвердить действие в локальном окне владельца." : "Не установлен локальный модуль разрешений SnarkBridge."}
        </small>
        {accessError ? <p className="bridgeNotice">{accessError}</p> : null}
      </div>
    </div>
    <span className="cardActions">
      <button type="button" onClick={() => void change("start")} disabled={busy || !control?.canStart} title="Запустить MCP-сервер и туннель">{action === "start" ? <LoaderCircle className="spin" /> : <Play />} Запустить</button>
      <button type="button" onClick={() => void change("stop")} disabled={busy || !control?.canStop} title="Остановить туннель и MCP-сервер; Watchdog не запустит их сам">{action === "stop" ? <LoaderCircle className="spin" /> : <Square />} Остановить</button>
      <button type="button" onClick={() => void change("restart")} disabled={busy || !control?.canRestart} title="Остановить и снова запустить">{action === "restart" ? <LoaderCircle className="spin" /> : <RotateCw />} Перезапуск</button>
      <button type="button" onClick={toggleLogs} className={logsOpen ? "active" : ""} title="Последние сообщения и ошибки запуска"><FileText /> Журнал</button>
    </span>
    {logsOpen ? <div className="bridgeLogs">
      <div className="bridgeLogsHead"><span>Журнал (ключи и токены скрыты)</span><button type="button" onClick={() => void loadLogs()} title="Обновить журнал"><RefreshCw /></button></div>
      {!logs ? <p>Загрузка…</p> : logs.length === 0 ? <p>Журналов пока нет.</p> : logs.map((source, index) => <details key={source.id} open={index === 0}>
        <summary>{source.title}{source.updatedAt ? ` · ${new Date(source.updatedAt).toLocaleString("ru-RU")}` : ""}</summary>
        <pre title={source.file}>{source.text || "(пусто)"}</pre>
      </details>)}
    </div> : null}
  </div>;
}
