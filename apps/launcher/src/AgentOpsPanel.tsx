import { useCallback, useEffect, useState } from "react";
import { Ban, CalendarClock, Cpu, FileText, ListChecks, LoaderCircle, Lock, Plus, ScrollText, Trash2 } from "lucide-react";

type Mode = "owner_busy" | "background" | "free";
type ScheduleRule = { id: string; days: number[]; from: string; to: string; mode: Mode; label?: string };
type TaskSummary = { id: string; title: string; state: string; reason: string; executor?: string; agentId: string; priority: number; depth: number; createdAt: string; updatedAt: string; workdir?: string; attempts: number };
type Lease = { id: string; purpose: string; class: "heavy" | "light"; vramMiB: number; agentId: string; state: string; estimateSource: string };
type LockRecord = { key: string; ownerTaskId: string; ownerAgentId: string; state: "held" | "suspect" };
type ExecutorStatus = { id: string; label: string; tier: string; probe: { installed: boolean; authenticated: boolean | null; detail?: string; checkedAt: string } | null;
  ledger: { quota: { state: string; usedPercent?: number; source?: string; observedAt?: string; simulated?: boolean }; nextAttemptAt?: string; lastVerifiedAt?: string; activeRuns: number };
  availability: { usable: boolean; reason?: string } };
export type AgentOpsStatus = {
  mode: { mode: Mode; label: string; source: string; reason: string; localTime: string; until?: string };
  manual: { mode: Mode; until?: string | null } | null;
  schedule: ScheduleRule[];
  ownerApps: string[];
  resources: { gpu?: { totalMiB: number; usedMiB: number; utilizationPercent: number }; memory: { totalMiB: number; usedMiB: number }; cpuCount: number } | null;
  leases: Lease[];
  locks: LockRecord[];
  queue: { counts: Record<string, number>; active: number };
  executors: ExecutorStatus[];
  tasks: TaskSummary[];
};
type TaskDetail = { task: TaskSummary & { result?: { summary: string; changedFiles: string[]; checks: Array<{ ok: boolean; detail: string; check: { type: string; command?: string; path?: string } }>; branch?: string; artifactPath?: string } };
  events: Array<{ at: string; type: string; message: string }> };

export const MODE_LABELS: Record<Mode, string> = { owner_busy: "Компьютер нужен мне", background: "Можно работать в фоне", free: "Компьютер свободен" };
const STATE_LABELS: Record<string, string> = {
  queued: "в очереди", waiting_window: "ждёт рабочего окна", waiting_resources: "ждёт ресурсов", waiting_executor: "ждёт исполнителя", running: "выполняется",
  blocked: "заблокирована", failed: "ошибка", cancelled: "отменена", unknown_outcome: "неизвестный исход", awaiting_verification: "ждёт проверки", verified: "проверена"
};
const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const TERMINAL = new Set(["verified", "failed", "cancelled"]);

async function call<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}/api/agent-ops${path}`, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

/** One poller shared by the top bar and the Agents panel. */
const listeners = new Set<(status: AgentOpsStatus | undefined, error: string) => void>();
let pollTimer: number | undefined;
let lastStatus: AgentOpsStatus | undefined;
function startPolling(apiBase: string) {
  if (pollTimer) return;
  const poll = async () => {
    if (document.hidden && lastStatus) return;
    try { lastStatus = await call<AgentOpsStatus>(apiBase, "/status"); listeners.forEach(listener => listener(lastStatus, "")); }
    catch (reason) { listeners.forEach(listener => listener(lastStatus, reason instanceof Error ? reason.message : String(reason))); }
  };
  void poll();
  pollTimer = window.setInterval(poll, 3000);
  window.addEventListener("snarkroute:agent-ops-changed", () => void poll());
}
export function useAgentOpsStatus(apiBase: string) {
  const [state, setState] = useState<{ status?: AgentOpsStatus; error: string }>({ status: lastStatus, error: "" });
  useEffect(() => {
    const listener = (status: AgentOpsStatus | undefined, error: string) => setState({ status, error });
    listeners.add(listener);
    startPolling(apiBase);
    return () => { listeners.delete(listener); };
  }, [apiBase]);
  return state;
}
const changed = () => window.dispatchEvent(new Event("snarkroute:agent-ops-changed"));

/** Usable now = found on this computer, signed in where needed, and no limit or pause in the ledger. */
function executorUsable(executor: ExecutorStatus): { usable: boolean; reason: string } {
  if (!executor.probe) return { usable: false, reason: "ещё не проверялся" };
  if (!executor.probe.installed) return { usable: false, reason: executor.probe.detail ?? "не обнаружен" };
  if (executor.probe.authenticated === false) return { usable: false, reason: executor.probe.detail ?? "нет входа по подписке" };
  return executor.availability.usable ? { usable: true, reason: "доступен" } : { usable: false, reason: executor.availability.reason ?? "недоступен" };
}

function gb(mib: number) { return (mib / 1024).toFixed(1); }

/** Visible in every section: mode, load, queue, locks, subscriptions. */
export function AgentOpsStatusBar({ apiBase }: { apiBase: string }) {
  const { status, error } = useAgentOpsStatus(apiBase);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  async function setMode(value: string) {
    setBusy(true); setLocalError("");
    try { await call(apiBase, "/mode", { method: "PUT", body: JSON.stringify({ mode: value === "schedule" ? null : value }) }); changed(); }
    catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  if (!status) return <div className="opsBar" title={error}>{error ? "Диспетчер задач недоступен" : "Диспетчер задач…"}</div>;
  const waiting = (status.queue.counts.queued ?? 0) + (status.queue.counts.waiting_window ?? 0) + (status.queue.counts.waiting_resources ?? 0) + (status.queue.counts.waiting_executor ?? 0);
  const attention = (status.queue.counts.blocked ?? 0) + (status.queue.counts.unknown_outcome ?? 0) + (status.queue.counts.awaiting_verification ?? 0);
  const gpu = status.resources?.gpu;
  return <div className={`opsBar mode-${status.mode.mode}`} title={localError || error || `${status.mode.reason} · ${status.mode.localTime} МСК`}>
    <label className="opsModeSelect">
      <span className="opsDot" />
      <select aria-label="Режим компьютера" value={status.manual ? status.manual.mode : "schedule"} disabled={busy} onChange={event => void setMode(event.target.value)}>
        <option value="schedule">Авто: {status.mode.source === "schedule" ? MODE_LABELS[status.mode.mode] : "фон (по умолчанию)"}</option>
        {(Object.keys(MODE_LABELS) as Mode[]).map(mode => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
      </select>
    </label>
    {gpu ? <span className="opsMetric" title={`GPU загрузка ${gpu.utilizationPercent}%`}><Cpu /> VRAM {gb(gpu.usedMiB)}/{gb(gpu.totalMiB)}</span> : null}
    {status.resources ? <span className="opsMetric">RAM {gb(status.resources.memory.usedMiB)}/{gb(status.resources.memory.totalMiB)}</span> : null}
    <span className="opsMetric" title="Выполняются / ждут / нужен ответ"><ListChecks /> {status.queue.counts.running ?? 0} · {waiting}{attention ? <b className="opsAttention"> · {attention}!</b> : null}</span>
    {status.locks.length ? <span className="opsMetric" title={status.locks.map(lock => `${lock.key} → ${lock.ownerTaskId}`).join("\n")}><Lock /> {status.locks.length}</span> : null}
    {status.executors.filter(executor => executor.tier === "subscription").map(executor => { const state = executorUsable(executor); return <span key={executor.id} className={`opsMetric ${state.usable ? "" : "warn"}`}
      title={`${executor.label}: ${state.reason} · квота ${executor.ledger.quota.state}${executor.ledger.quota.source ? ` (${executor.ledger.quota.source})` : ""}`}>
      {executor.id === "codex_cli" ? "Codex" : "Claude"} {state.usable ? "✓" : "⏸"}
    </span>; })}
    {status.ownerApps.length ? <span className="opsMetric warn" title="Приложения владельца: тяжёлая фоновая работа ждёт">{status.ownerApps.join(", ")}</span> : null}
  </div>;
}

export function AgentOpsPanel({ apiBase }: { apiBase: string }) {
  const { status, error } = useAgentOpsStatus(apiBase);
  const [open, setOpen] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [log, setLog] = useState("");
  const [action, setAction] = useState("");
  const [notice, setNotice] = useState("");
  const [rule, setRule] = useState<ScheduleRule>({ id: "", days: [1, 2, 3, 4, 5], from: "10:00", to: "19:00", mode: "owner_busy", label: "" });

  const loadDetail = useCallback(async (id: string) => {
    const [next, logs] = await Promise.all([call<TaskDetail>(apiBase, `/tasks/${encodeURIComponent(id)}`), call<{ log: string }>(apiBase, `/tasks/${encodeURIComponent(id)}/log`)]);
    setDetail(next); setLog(logs.log);
  }, [apiBase]);
  useEffect(() => {
    if (!open) return;
    void loadDetail(open).catch(reason => setNotice(String(reason)));
    const timer = window.setInterval(() => void loadDetail(open).catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [open, loadDetail]);

  async function act(key: string, run: () => Promise<unknown>, done?: string) {
    setAction(key); setNotice("");
    try { await run(); if (done) setNotice(done); changed(); if (open) await loadDetail(open).catch(() => undefined); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAction(""); }
  }
  const setManual = (mode: Mode | null, minutes?: number) => act(`mode:${mode}`, () => call(apiBase, "/mode", { method: "PUT", body: JSON.stringify({ mode, minutes }) }));
  const saveSchedule = (rules: ScheduleRule[]) => act("schedule", () => call(apiBase, "/schedule", { method: "PUT", body: JSON.stringify({ rules }) }), "Расписание сохранено.");

  if (!status) return <div className="opsWorkspace"><p className="secretarySummary">{error ? `Диспетчер задач недоступен: ${error}` : <><LoaderCircle className="spin" /> Загружаю диспетчер задач…</>}</p></div>;
  const active = status.tasks.filter(task => !TERMINAL.has(task.state));
  const finished = status.tasks.filter(task => TERMINAL.has(task.state));

  const taskRow = (task: TaskSummary) => <article key={task.id} className={`opsTask state-${task.state}`}>
    <div className="opsTaskHead">
      <strong>{task.title}</strong>
      <span className="opsState">{STATE_LABELS[task.state] ?? task.state}</span>
    </div>
    <p className="opsReason">{task.reason}</p>
    <div className="secretaryMeta"><span>{task.id} · {task.agentId}{task.executor ? ` → ${task.executor}` : ""}{task.depth > 1 ? ` · глубина ${task.depth}` : ""}</span><span>{new Date(task.updatedAt).toLocaleString("ru-RU")}</span></div>
    <div className="opsActions">
      <button type="button" className="secretaryButton" onClick={() => setOpen(open === task.id ? undefined : task.id)}><FileText /> {open === task.id ? "Скрыть" : "Результат и журнал"}</button>
      {!TERMINAL.has(task.state) ? <button type="button" className="secretaryButton" disabled={action === `cancel:${task.id}`} onClick={() => void act(`cancel:${task.id}`, () => call(apiBase, `/tasks/${task.id}/cancel`, { method: "POST", body: "{}" }))}><Ban /> Отменить</button> : null}
      {["blocked", "unknown_outcome"].includes(task.state) ? <>
        <button type="button" className="secretaryButton" onClick={() => void act(`resolve:${task.id}`, () => call(apiBase, `/tasks/${task.id}/resolve`, { method: "POST", body: JSON.stringify({ action: "continue" }) }))}>Продолжить с текущего состояния</button>
        <button type="button" className="secretaryButton" onClick={() => void act(`resolve:${task.id}`, () => call(apiBase, `/tasks/${task.id}/resolve`, { method: "POST", body: JSON.stringify({ action: "mark_failed" }) }))}>Отметить ошибкой</button>
      </> : null}
      {["awaiting_verification", "unknown_outcome"].includes(task.state) ? <button type="button" className="secretaryButton" onClick={() => void act(`resolve:${task.id}`, () => call(apiBase, `/tasks/${task.id}/resolve`, { method: "POST", body: JSON.stringify({ action: "mark_verified", note: "проверено владельцем в Мастерской" }) }))}>Я проверил: принять</button> : null}
    </div>
    {open === task.id && detail?.task.id === task.id ? <div className="opsDetail">
      {detail.task.result ? <>
        <p className="secretaryContext"><strong>Итог исполнителя:</strong> {detail.task.result.summary || "—"}</p>
        {detail.task.result.checks.length ? <ul className="opsChecks">{detail.task.result.checks.map((check, index) => <li key={index} className={check.ok ? "ok" : "bad"}>{check.ok ? "✓" : "✗"} {check.check.command ?? check.check.path ?? check.check.type}: {check.detail.split("\n").slice(0, 3).join(" ")}</li>)}</ul> : null}
        {detail.task.result.changedFiles.length ? <p className="secretaryContext">Изменены: {detail.task.result.changedFiles.slice(0, 30).join(", ")}</p> : null}
        {detail.task.result.branch ? <p className="secretaryContext">Ветка: {detail.task.result.branch}</p> : null}
      </> : null}
      <details><summary><ScrollText /> События ({detail.events.length})</summary><ol className="opsEvents">{detail.events.slice(-40).map((event, index) => <li key={index}><time>{new Date(event.at).toLocaleTimeString("ru-RU")}</time> {event.message}</li>)}</ol></details>
      <details><summary><ScrollText /> Журнал исполнителя</summary><pre className="opsLog">{log || "пусто"}</pre></details>
    </div> : null}
  </article>;

  return <div className="opsWorkspace">
    <header className="secretaryHeader">
      <div><h2>Диспетчер задач агентов</h2><p>Поручения, которые агенты передают Codex, Claude Code и локальным моделям. Ресурсы выдаются только в разрешённом режиме; результат принимается по проверкам, а не по словам исполнителя.</p></div>
      <div className="opsModeButtons" role="group" aria-label="Режим компьютера">
        {(Object.keys(MODE_LABELS) as Mode[]).map(mode => <button type="button" key={mode} className={`secretaryButton ${status.mode.mode === mode ? "primary" : ""}`} disabled={Boolean(action)} onClick={() => void setManual(mode)}>{MODE_LABELS[mode]}</button>)}
        <button type="button" className="secretaryButton" disabled={!status.manual || Boolean(action)} onClick={() => void setManual(null)}><CalendarClock /> По расписанию</button>
      </div>
    </header>
    <p className="secretarySummary">Сейчас: <strong className="opsModeNow">{status.mode.label}</strong> · {status.mode.reason} · {status.mode.localTime} МСК
      {status.manual ? <> · <button type="button" className="secretaryButton" onClick={() => void setManual(status.manual!.mode, 60)}>на 1 час</button><button type="button" className="secretaryButton" onClick={() => void setManual(status.manual!.mode, 240)}>на 4 часа</button></> : null}</p>
    {notice ? <div className="errorBanner" role="status">{notice}</div> : null}

    <section className="opsColumns">
      <div className="opsColumn">
        <h3>Активные ({active.length})</h3>
        {!active.length ? <div className="secretaryEmpty">Активных поручений нет.</div> : active.map(taskRow)}
        <details className="secretaryArchive"><summary>Завершённые ({finished.length})</summary><div className="secretaryArchiveList">{finished.map(taskRow)}</div></details>
      </div>
      <div className="opsColumn">
        <h3>Исполнители</h3>
        {status.executors.map(executor => <div key={executor.id} className="opsExecutor">
          <strong>{executor.label}</strong>
          <span className={executorUsable(executor).usable ? "ok" : "bad"}>{executorUsable(executor).reason}</span>
          <small>установлен: {executor.probe ? (executor.probe.installed ? "да" : "нет") : "?"} · вход: {executor.probe?.authenticated === null ? "не нужен" : executor.probe?.authenticated ? "да" : "нет"} · квота: {executor.ledger.quota.state}
            {executor.ledger.quota.usedPercent !== undefined ? ` ${executor.ledger.quota.usedPercent}%` : ""}{executor.ledger.quota.simulated ? " (симуляция)" : ""}{executor.ledger.quota.source ? ` · ${executor.ledger.quota.source}` : ""}
            {executor.ledger.lastVerifiedAt ? ` · проверен ${new Date(executor.ledger.lastVerifiedAt).toLocaleString("ru-RU")}` : " · проверенных запусков нет"}</small>
        </div>)}
        <h3>Резервы и блокировки</h3>
        {!status.leases.length && !status.locks.length ? <p className="secretaryContext">Нет активных резервов ресурсов и блокировок.</p> : null}
        {status.leases.map(lease => <p key={lease.id} className="secretaryContext"><Cpu /> {lease.class === "heavy" ? "тяжёлая" : "лёгкая"} · {lease.purpose}{lease.vramMiB ? ` · ${gb(lease.vramMiB)} ГБ VRAM (${lease.estimateSource})` : ""}{lease.state !== "active" ? " · сверяется" : ""}</p>)}
        {status.locks.map(lock => <p key={lock.key} className="secretaryContext"><Lock /> {lock.key} → {lock.ownerTaskId}{lock.state === "suspect" ? " · ждёт сверки после сбоя" : ""}</p>)}

        <h3>Расписание (Europe/Moscow)</h3>
        <p className="secretaryContext">Ручной режим важнее расписания. Без подходящего окна действует «Можно работать в фоне».</p>
        {status.schedule.map(item => <div key={item.id} className="opsRule"><span>{item.days.map(day => DAYS[day - 1]).join(",")} {item.from}–{item.to} → {MODE_LABELS[item.mode]}{item.label ? ` · ${item.label}` : ""}</span>
          <button type="button" className="secretaryButton" aria-label="Удалить правило" onClick={() => void saveSchedule(status.schedule.filter(existing => existing.id !== item.id))}><Trash2 /></button></div>)}
        <form className="opsRuleForm" onSubmit={event => { event.preventDefault(); void saveSchedule([...status.schedule, { ...rule, id: `rule-${Date.now()}`, label: rule.label?.trim() || undefined }]); }}>
          <div className="opsDays">{DAYS.map((day, index) => <label key={day}><input type="checkbox" checked={rule.days.includes(index + 1)} onChange={event => setRule(current => ({ ...current, days: event.target.checked ? [...current.days, index + 1].sort() : current.days.filter(value => value !== index + 1) }))} />{day}</label>)}</div>
          <input type="time" value={rule.from} onChange={event => setRule(current => ({ ...current, from: event.target.value }))} aria-label="С" />
          <input type="time" value={rule.to} onChange={event => setRule(current => ({ ...current, to: event.target.value }))} aria-label="До" />
          <select value={rule.mode} onChange={event => setRule(current => ({ ...current, mode: event.target.value as Mode }))} aria-label="Режим">{(Object.keys(MODE_LABELS) as Mode[]).map(mode => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}</select>
          <input type="text" placeholder="подпись" value={rule.label} maxLength={80} onChange={event => setRule(current => ({ ...current, label: event.target.value }))} />
          <button type="submit" className="secretaryButton" disabled={!rule.days.length || action === "schedule"}><Plus /> Добавить окно</button>
        </form>
      </div>
    </section>
  </div>;
}
