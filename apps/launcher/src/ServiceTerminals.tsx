import { ChevronDown, ChevronUp, Copy, Eraser, ExternalLink, Pause, Play, Search, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/*
 * Мастерская terminals: read-only live view of local services' console output.
 * The service list and its log sources come from the SnarkRoute API (runtime registry), never a
 * hard-coded list. Closing or collapsing the panel only stops polling; processes are untouched.
 */

export type LogSource = { id: string; title: string; owner: "managed" | "own-file"; path?: string; available: boolean; size: number; updatedAt?: string; note?: string; errorMark?: string; lastError?: string };
export type LogService = { id: string; label: string; online?: boolean; logsAvailable: boolean; note?: string; sources: LogSource[] };
type Chunk = { available: boolean; text: string; cursor: number; size: number; reset: boolean; path?: string; updatedAt?: string };
type Line = { id: number; text: string; level: "error" | "warn" | "" };

const ERROR_LINE = /\b(?:error|errors|fatal|critical|panic|exception|traceback|failed|failure|unhandled)\b|fullyqualifiederrorid|ошибк|не удалось|сбой/i;
const NOT_ERROR_LINE = /\b(?:0|no|zero) errors?\b|\berrors?\s*[=:]\s*0\b|\berror\s*[=:]\s*(?:""|null|none)/i;
const EXCEPTION_NAME = /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/;
const WARNING_LINE = /\bwarn(?:ing)?s?\b|deprecat|предупрежд/i;
const MAX_LINES = 5000;
const SEEN_KEY = "snarkroute.terminals.seen";
const HEIGHT_KEY = "snarkroute.terminals.height";

const LEVEL_FIELD = /\blevel["']?\s*[=:]\s*["']?([a-z]+|\d{2})\b/i;
const LEVEL_TOKEN = /(?:^|[\s[|(,])(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|CRITICAL|FATAL|PANIC)(?=[\s\]:|)]|$)/;

/** Same rules as the server's classifyLogLine: a line's own log level wins, otherwise keywords. */
export function lineLevel(text: string): Line["level"] {
  const explicit = (LEVEL_FIELD.exec(text)?.[1] ?? LEVEL_TOKEN.exec(text)?.[1])?.toLowerCase();
  if (explicit) {
    if (/^(?:error|err|critical|fatal|panic|50|60)$/.test(explicit)) return "error";
    if (/^(?:warn|warning|40)$/.test(explicit)) return "warn";
    if (/^(?:trace|debug|info|notice|10|20|30)$/.test(explicit)) return "";
  }
  if ((ERROR_LINE.test(text) || EXCEPTION_NAME.test(text)) && !NOT_ERROR_LINE.test(text)) return "error";
  return WARNING_LINE.test(text) ? "warn" : "";
}

/* ---------- shared summary store (one poller for the deck indicators and the panel) ---------- */

type Store = { services: LogService[]; seen: Record<string, Record<string, string>>; error?: string };
let store: Store = { services: [], seen: readJson(SEEN_KEY) ?? {} };
const listeners = new Set<() => void>();
let poller: number | undefined;
let storeApiBase = "";

function readJson<T>(key: string): T | undefined {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : undefined; } catch { return undefined; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function emit(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach(listener => listener());
}

async function pollSummary() {
  try {
    const response = await fetch(`${storeApiBase}/api/system/local-runtimes/logs`, { signal: AbortSignal.timeout(8000) });
    const body = await response.json() as { ok: boolean; services?: LogService[]; error?: string };
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const services = body.services ?? [];
    // First sight of a source: its existing errors are history, not a new alert.
    const seen = { ...store.seen };
    let changed = false;
    for (const service of services) for (const source of service.sources) {
      if (!source.errorMark) continue;
      seen[service.id] ??= {};
      if (seen[service.id][source.id] === undefined) { seen[service.id] = { ...seen[service.id], [source.id]: source.errorMark }; changed = true; }
    }
    if (changed) writeJson(SEEN_KEY, seen);
    emit({ services, seen, error: undefined });
  } catch (reason) {
    emit({ error: reason instanceof Error ? reason.message : String(reason) });
  }
}

export function useServiceLogs(apiBase: string) {
  const [, setTick] = useState(0);
  useEffect(() => {
    storeApiBase = apiBase;
    const listener = () => setTick(value => value + 1);
    listeners.add(listener);
    if (poller === undefined) { void pollSummary(); poller = window.setInterval(() => void pollSummary(), 3000); }
    return () => {
      listeners.delete(listener);
      if (!listeners.size && poller !== undefined) { window.clearInterval(poller); poller = undefined; }
    };
  }, [apiBase]);
  const alerts = useMemo(() => {
    const result = new Set<string>();
    for (const service of store.services) {
      if (service.sources.some(source => source.errorMark && store.seen[service.id]?.[source.id] !== source.errorMark)) result.add(service.id);
    }
    return result;
  }, [store]);
  return { services: store.services, alerts, error: store.error };
}

export function markServiceLogsSeen(serviceId: string) {
  const service = store.services.find(entry => entry.id === serviceId);
  if (!service) return;
  const marks = Object.fromEntries(service.sources.filter(source => source.errorMark).map(source => [source.id, source.errorMark!]));
  const seen = { ...store.seen, [serviceId]: { ...store.seen[serviceId], ...marks } };
  writeJson(SEEN_KEY, seen);
  emit({ seen });
}

/** Opens the terminal panel, optionally on one service's tab (used by the deck context menu). */
export function showTerminal(serviceId?: string) {
  window.dispatchEvent(new CustomEvent("snarkroute:terminal", { detail: { serviceId } }));
}

/* ---------- deck button ---------- */

export function TerminalsButton({ apiBase }: { apiBase: string }) {
  const { alerts } = useServiceLogs(apiBase);
  return <button type="button" className={`terminalsButton ${alerts.size ? "alert" : ""}`} title={alerts.size ? `Терминалы · новые ошибки: ${alerts.size}` : "Терминалы: журналы локальных процессов"} aria-label="Терминалы" onClick={() => window.dispatchEvent(new CustomEvent("snarkroute:terminal", { detail: { toggle: true } }))}>
    <SquareTerminal /><span>Терминалы</span>
  </button>;
}

/* ---------- panel under the deck ---------- */

export function TerminalPanel({ apiBase }: { apiBase: string }) {
  const { services } = useServiceLogs(apiBase);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [active, setActive] = useState<string>();
  const [height, setHeight] = useState(() => readJson<number>(HEIGHT_KEY) ?? 300);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ serviceId?: string; toggle?: boolean }>).detail ?? {};
      if (detail.toggle) { setOpen(value => !value); setCollapsed(false); return; }
      setOpen(true); setCollapsed(false);
      if (detail.serviceId) setActive(detail.serviceId);
    };
    window.addEventListener("snarkroute:terminal", handler);
    return () => window.removeEventListener("snarkroute:terminal", handler);
  }, []);

  useEffect(() => {
    if (!active && services.length) setActive(services[0].id);
  }, [services, active]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(window.innerHeight * 0.85, Math.max(140, startHeight + moveEvent.clientY - startY)));
      setHeight(next);
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      writeJson(HEIGHT_KEY, Math.round(Math.min(window.innerHeight * 0.85, Math.max(140, startHeight + upEvent.clientY - startY))));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  if (!open) return null;
  return <section className={`terminalPanel ${collapsed ? "collapsed" : ""}`} aria-label="Терминалы локальных процессов">
    <TerminalTabs apiBase={apiBase} services={services} active={active} onSelect={id => { setActive(id); setCollapsed(false); }}
      actions={<>
        <button type="button" title={collapsed ? "Развернуть" : "Свернуть"} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronDown /> : <ChevronUp />}</button>
        <button type="button" title="Закрыть панель (процессы продолжат работу)" onClick={() => setOpen(false)}><X /></button>
      </>} />
    {!collapsed && active ? <>
      <TerminalView apiBase={apiBase} service={services.find(service => service.id === active)} height={height} />
      <div className="terminalResize" onPointerDown={startResize} title="Потяните, чтобы изменить высоту" />
    </> : null}
  </section>;
}

function TerminalTabs({ apiBase, services, active, onSelect, actions }: { apiBase: string; services: LogService[]; active?: string; onSelect: (id: string) => void; actions?: React.ReactNode }) {
  const { alerts } = useServiceLogs(apiBase);
  return <div className="terminalTabs">
    <SquareTerminal className="terminalTabsIcon" />
    <div className="terminalTabList" role="tablist">
      {services.map(service => <button key={service.id} type="button" role="tab" aria-selected={service.id === active}
        className={`terminalTab ${service.id === active ? "active" : ""} ${service.logsAvailable ? "" : "nolog"}`}
        title={service.note ?? service.label} onClick={() => onSelect(service.id)}>
        <span className={`terminalTabDot ${service.online ? "on" : service.online === false ? "off" : ""}`} />
        {service.label}
        {alerts.has(service.id) ? <span className="terminalAlertDot" aria-label="новые ошибки" /> : null}
      </button>)}
    </div>
    <div className="terminalTabActions">{actions}</div>
  </div>;
}

export function TerminalView({ apiBase, service, height, standalone = false, initialSource }: { apiBase: string; service?: LogService; height?: number; standalone?: boolean; initialSource?: string }) {
  const [sourceId, setSourceId] = useState<string | undefined>(initialSource);
  const [lines, setLines] = useState<Line[]>([]);
  const [chunk, setChunk] = useState<Chunk>();
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const cursor = useRef<number | undefined>(undefined);
  const nextId = useRef(0);
  const partial = useRef("");

  const sources = service?.sources ?? [];
  const source = sources.find(entry => entry.id === sourceId) ?? sources.find(entry => entry.available) ?? sources[0];

  useEffect(() => { if (service?.id) markServiceLogsSeen(service.id); }, [service?.id, service?.sources.map(entry => entry.errorMark).join("|")]);

  useEffect(() => {
    cursor.current = undefined; partial.current = ""; setLines([]); setChunk(undefined); setError("");
    if (!service || !source) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const query = new URLSearchParams({ source: source.id, ...(cursor.current === undefined ? {} : { cursor: String(cursor.current) }) });
        const response = await fetch(`${apiBase}/api/system/local-runtimes/${encodeURIComponent(service.id)}/logs?${query}`, { signal: AbortSignal.timeout(8000) });
        const next = await response.json() as Chunk & { ok: boolean; error?: string };
        if (!response.ok || !next.ok) throw new Error(next.error || `HTTP ${response.status}`);
        if (disposed) return;
        setChunk(next); setError("");
        cursor.current = next.cursor;
        if (next.text || next.reset) {
          const pieces = (partial.current + next.text).split(/\r\n|\r|\n/);
          partial.current = pieces.pop() ?? "";
          const added = pieces.filter((text, index) => text || index < pieces.length - 1).map(text => ({ id: nextId.current++, text, level: lineLevel(text) }));
          setLines(current => {
            const merged = next.reset ? [{ id: nextId.current++, text: "— журнал был ротирован или очищен на диске —", level: "warn" as const }, ...added] : [...current, ...added];
            return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
          });
        }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => { disposed = true; if (timer) window.clearTimeout(timer); };
  }, [apiBase, service?.id, source?.id, source?.available]);

  const matcher = useMemo(() => {
    const text = query.trim();
    if (!text) return undefined;
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }, [query]);
  const visible = useMemo(() => matcher && onlyMatches ? lines.filter(line => line.text.search(matcher) >= 0) : lines, [lines, matcher, onlyMatches]);
  const matches = useMemo(() => matcher ? visible.filter(line => line.text.search(matcher) >= 0).map(line => line.id) : [], [visible, matcher]);

  useEffect(() => {
    if (follow && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [visible, follow]);

  function onScroll() {
    const element = body.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    if (!atBottom && follow) setFollow(false);
    if (atBottom && !follow) setFollow(true);
  }

  function jump(step: number) {
    if (!matches.length || !body.current) return;
    const index = (matchIndex + step + matches.length) % matches.length;
    setMatchIndex(index);
    setFollow(false);
    body.current.querySelector(`[data-line="${matches[index]}"]`)?.scrollIntoView({ block: "center" });
  }

  async function copy() {
    const text = visible.map(line => line.text).join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
    catch { setError("Буфер обмена недоступен"); }
  }

  if (!service) return <div className="terminalEmpty" style={{ height }}>Нет зарегистрированных процессов.</div>;
  const note = source?.note ?? service.note;
  return <div className={`terminalView ${standalone ? "standalone" : ""}`}>
    <div className="terminalToolbar">
      {sources.length > 1 ? <div className="terminalSources">
        {sources.map(entry => <button key={entry.id} type="button" className={entry.id === source?.id ? "active" : ""} disabled={!entry.available && entry.id !== source?.id}
          title={entry.path ?? entry.note ?? entry.title} onClick={() => setSourceId(entry.id)}>{entry.title}{entry.owner === "own-file" ? " · свой журнал" : ""}</button>)}
      </div> : null}
      <label className="terminalSearch"><Search />
        <input value={query} placeholder="Поиск" onChange={event => { setQuery(event.target.value); setMatchIndex(0); }}
          onKeyDown={event => { if (event.key === "Enter") jump(event.shiftKey ? -1 : 1); if (event.key === "Escape") setQuery(""); }} />
        {matcher ? <span className="terminalMatchCount">{matches.length ? `${matchIndex % matches.length + 1}/${matches.length}` : "0"}</span> : null}
      </label>
      {matcher ? <button type="button" className={onlyMatches ? "active" : ""} title="Показывать только совпадения" onClick={() => setOnlyMatches(value => !value)}>фильтр</button> : null}
      <span className="terminalToolbarSpacer" />
      <button type="button" className={follow ? "" : "active"} title={follow ? "Приостановить автопрокрутку" : "Возобновить автопрокрутку"} onClick={() => setFollow(value => !value)}>{follow ? <Pause /> : <Play />}</button>
      <button type="button" title="Копировать видимый текст" onClick={() => void copy()}>{copied ? "✓" : <Copy />}</button>
      <button type="button" title="Очистить отображение (файл журнала не меняется)" onClick={() => setLines([])}><Eraser /></button>
      {!standalone ? <button type="button" title="Открыть журнал в отдельном окне" onClick={() => window.open(`/logs?service=${encodeURIComponent(service.id)}${source ? `&source=${encodeURIComponent(source.id)}` : ""}`, `snarkroute-log-${service.id}`)}><ExternalLink /></button> : null}
    </div>
    {note ? <div className="terminalNote">{note}</div> : null}
    <div className="terminalBody" ref={body} onScroll={onScroll} style={standalone ? undefined : { height }}>
      {!source ? <div className="terminalPlaceholder">Для этого процесса журнал недоступен.</div>
        : chunk && !chunk.available ? <div className="terminalPlaceholder">{source.note ?? "Файл журнала пока не создан: процесс ещё не запускался из Мастерской."}</div>
        : !visible.length ? <div className="terminalPlaceholder">{lines.length ? "Нет совпадений." : "Журнал пуст — ожидаю вывод…"}</div>
        : visible.map(line => <div key={line.id} data-line={line.id} className={`terminalLine ${line.level} ${matches[matchIndex % (matches.length || 1)] === line.id ? "current" : ""}`}>{highlight(line.text, matcher)}</div>)}
    </div>
    <div className="terminalStatus">
      <span title={source?.path}>{source?.path ?? "—"}</span>
      <span>{chunk?.available ? `${formatBytes(chunk.size)} · ${chunk.updatedAt ? new Date(chunk.updatedAt).toLocaleTimeString("ru-RU") : ""}` : ""}{follow ? "" : " · автопрокрутка на паузе"}{error ? ` · ${error}` : ""}</span>
    </div>
  </div>;
}

function highlight(text: string, matcher?: RegExp) {
  if (!matcher || !text) return text || " ";
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(<mark key={index}>{match[0]}</mark>);
    last = index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(0, Math.round(bytes / 1024))} КБ`;
}

/* ---------- standalone window: /logs?service=…&source=… ---------- */

export function TerminalPage({ apiBase }: { apiBase: string }) {
  const params = new URLSearchParams(location.search);
  const { services } = useServiceLogs(apiBase);
  const [active, setActive] = useState(params.get("service") ?? undefined);
  const service = services.find(entry => entry.id === active) ?? services[0];
  useEffect(() => { document.title = `Журнал · ${service?.label ?? "Мастерская"}`; }, [service?.label]);
  return <main className="terminalPage">
    <TerminalTabs apiBase={apiBase} services={services} active={service?.id} onSelect={setActive} />
    <TerminalView apiBase={apiBase} service={service} standalone initialSource={service?.id === params.get("service") ? params.get("source") ?? undefined : undefined} />
  </main>;
}

/* ---------- context menu for the deck items ---------- */

export function useTerminalContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; serviceId: string; label: string }>();
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); window.removeEventListener("blur", close); };
  }, [menu]);
  const onContextMenu = (event: React.MouseEvent) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-service-id]");
    if (!item) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, serviceId: item.dataset.serviceId!, label: item.dataset.serviceLabel ?? item.dataset.serviceId! });
  };
  const element = menu ? <div className="terminalMenu" style={{ left: menu.x, top: menu.y }} role="menu" onPointerDown={event => event.stopPropagation()}>
    <button type="button" role="menuitem" onClick={() => { showTerminal(menu.serviceId); setMenu(undefined); }}><SquareTerminal /> Показать терминал · {menu.label}</button>
  </div> : null;
  return { onContextMenu, element };
}
