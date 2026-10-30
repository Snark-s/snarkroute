import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Ban, CalendarClock, Cpu, FileText, ListChecks, LoaderCircle, Lock, Plus, ScrollText, Trash2 } from "lucide-react";
import { continueWithAdditionalAttempt } from "./task-attempt-control";

type Mode = "owner_busy" | "background" | "free";
type ScheduleRule = { id: string; days: number[]; from: string; to: string; mode: Mode; label?: string };
type Criterion = { id: string; description: string; required?: boolean; review: string; unverifiableReason?: string };
type Review = { at: string; attempt: number; decision: string; reason: string; nextStep: string; criteria: Array<{ criterionId: string; status: string; reason: string; evidenceIds: string[] }>; reviewer?: { executor: string; model?: string; level: string } };
type ChainBudget = { subscriptionRunsUsed: number; subscriptionRunsLeft: number; wallMinutesUsed: number; wallMinutesLeft: number };
type TaskBudget = { wallMinutesUsed: number; wallMinutesLeft: number; wallMinutesLimit: number; subscriptionRunsUsed: number; subscriptionRunsLimit: number; attemptsUsed: number; attemptsLimit: number; providerCost: number };
type TaskSummary = { id: string; title: string; state: string; reason: string; executor?: string; agentId: string; priority: number; depth: number; createdAt: string; updatedAt: string; workdir?: string; attempts: number; nextStep?: string; nextAttemptAt?: string; lastDecision?: Review; criteria?: Criterion[]; chainBudget?: ChainBudget; taskBudget?: TaskBudget };
type Lease = { id: string; purpose: string; class: "heavy" | "light"; vramMiB: number; agentId: string; state: string; estimateSource: string };
type LockRecord = { key: string; ownerTaskId: string; ownerAgentId: string; state: "held" | "suspect" };
type Coverage = {
  measuredBySnarkRoute: { delegatedRuns: number; chatTurns: number; inputTokens: number; outputTokens: number; lastAt?: string; scope: string };
  providerReport: { state: string; usedPercent?: number; resetsAt?: string; source?: string; observedAt?: string; stale: boolean; scope: string } | null;
  externalUsage: { observed: false; note: string };
  ourLimits: { concurrent: number; sharedSubscriptionConcurrent: number; dailyRuns: number | null; activeRuns: number };
};
type ExecutorStatus = { id: string; label: string; tier: string; probe: { installed: boolean; authenticated: boolean | null; detail?: string; checkedAt: string } | null;
  ledger: { quota: { state: string; usedPercent?: number; source?: string; observedAt?: string; simulated?: boolean }; nextAttemptAt?: string; lastVerifiedAt?: string; activeRuns: number };
  coverage?: Coverage;
  availability: { usable: boolean; reason?: string } };
type OwnerActivity = { busy: boolean; confidence: "measured" | "unknown"; reasons: string[]; signals: string[]; sampledAt?: string };
export type AgentOpsStatus = {
  mode: { mode: Mode; label: string; source: string; reason: string; localTime: string; until?: string };
  manual: { mode: Mode; until?: string | null } | null;
  schedule: ScheduleRule[];
  ownerApps: string[];
  ownerActivity?: OwnerActivity;
  resources: { gpu?: { totalMiB: number; usedMiB: number; utilizationPercent: number }; memory: { totalMiB: number; usedMiB: number }; cpuCount: number } | null;
  leases: Lease[];
  locks: LockRecord[];
  queue: { counts: Record<string, number>; active: number };
  executors: ExecutorStatus[];
  tasks: TaskSummary[];
};
type TaskDetail = { task: TaskSummary & { contract?: { originalGoal: string; expectedResult: string; revision: number; criteria: Criterion[] }; reviews?: Review[];
  evidence?: Array<{ id: string; attempt: number; criterionId: string; observedAt: string; source: string; ok: boolean; detail: string; content?: string; digest: string }>;
  effects?: Array<{ key: string; state: string; detail?: string }>; reviewRuns?: Array<{ executor: string; model?: string; level: string; outcome?: string; error?: string }>;
  result?: { summary: string; changedFiles: string[]; checks: Array<{ ok: boolean; detail: string; check: { type: string; command?: string; path?: string } }>; branch?: string; artifactPath?: string } };
  chainBudget?: ChainBudget;
  events: Array<{ at: string; type: string; message: string }> };

export const MODE_LABELS: Record<Mode, string> = { owner_busy: "Компьютер нужен мне", background: "Можно работать в фоне", free: "Компьютер свободен" };
const STATE_LABELS: Record<string, string> = {
  queued: "в очереди", waiting_window: "ждёт рабочего окна", waiting_resources: "ждёт ресурсов", waiting_executor: "ждёт исполнителя", running: "выполняется",
  blocked: "заблокирована", failed: "ошибка", cancelled: "отменена", paused: "приостановлена", unknown_outcome: "неизвестный исход", awaiting_verification: "ждёт проверки", verified: "принята"
};
const DECISIONS: Record<string, string> = { accept: "принять", continue: "продолжить", change_approach: "сменить подход или исполнителя", wait_resource: "ожидать ресурс", blocked: "заблокировано", owner_action: "требуется действие владельца" };
const VERDICTS: Record<string, string> = { confirmed: "подтверждён", missing: "не выполнен", unverifiable: "не проверен" };
const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const TERMINAL = new Set(["verified", "failed", "cancelled"]);

/**
 * Owner session of the Workshop. It is obtained only by redeeming a one-time code that the launcher
 * (the owner's own process, holding the launcher token) puts into the URL fragment; browser headers
 * grant nothing. The code is removed from the address bar right after the exchange.
 */
const SESSION_KEY = "snarkroute.ownerSession";
const controlBase = `http://127.0.0.1:${import.meta.env.VITE_LAUNCHER_CONTROL_PORT || 5176}`;
let ownerSession: Promise<string> | undefined;

function storedSession(): string | undefined {
  try { return localStorage.getItem(SESSION_KEY) ?? undefined; } catch { return undefined; }
}
function storeSession(value: string | undefined): void {
  try { if (value) localStorage.setItem(SESSION_KEY, value); else localStorage.removeItem(SESSION_KEY); } catch { /* private mode: session lives in memory only */ }
}

/** Runs once on load: exchange `#owner-code=` for a session and drop the code from the URL and history. */
export async function redeemOwnerCode(apiBase: string): Promise<void> {
  const match = /(?:^#|&)owner-code=([^&]+)/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, "", location.pathname + location.search);
  const response = await fetch(`${apiBase}/api/agent-ops/owner-session`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: decodeURIComponent(match[1]) }), signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({})) as { session?: string; error?: string };
  if (!response.ok || !body.session) throw new Error(body.error || "Код входа не принят");
  storeSession(body.session);
  ownerSession = Promise.resolve(body.session);
  window.dispatchEvent(new Event("snarkroute:agent-ops-changed"));
}

/** Asks the launcher to open a signed-in Workshop tab; this tab picks the session up through localStorage. */
export async function requestOwnerLogin(): Promise<void> {
  const response = await fetch(`${controlBase}/owner-login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Лаунчер не открыл вход: перезапустите его ярлыком Мастерской");
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key !== SESSION_KEY) return;
    ownerSession = event.newValue ? Promise.resolve(event.newValue) : undefined;
    window.dispatchEvent(new Event("snarkroute:agent-ops-changed"));
  });
}

function session(_apiBase: string, renew = false): Promise<string> {
  if (renew) { ownerSession = undefined; storeSession(undefined); }
  const stored = storedSession();
  ownerSession ??= stored ? Promise.resolve(stored) : Promise.reject(new OwnerLoginRequired());
  return ownerSession.catch(error => { ownerSession = undefined; throw error; });
}

/** Owner session header for other Workshop pages (Бужа); empty when not signed in. */
export async function ownerHeaders(): Promise<Record<string, string>> {
  return session("").then(value => ({ "x-snarkroute-owner-session": value }), () => ({}));
}

export class OwnerLoginRequired extends Error {
  constructor() { super("Нужен вход владельца: нажмите «Войти как владелец»."); this.name = "OwnerLoginRequired"; }
}

async function call<T>(apiBase: string, path: string, init?: RequestInit, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  const signedIn = await session(apiBase).then(value => { headers["x-snarkroute-owner-session"] = value; return true; }, () => false);
  // Without a session the Workshop still reads the public status; actions answer 401 and ask for login.
  if (!signedIn && (init?.method ?? "GET") !== "GET") throw new OwnerLoginRequired();
  if (init?.body) headers["content-type"] = "application/json";
  const response = await fetch(`${apiBase}/api/agent-ops${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({})) as T & { ok?: boolean; error?: string; code?: string };
  if (response.status === 401 && signedIn && retry) { storeSession(undefined); ownerSession = undefined; throw new OwnerLoginRequired(); }
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function AdditionalAttemptControl({apiBase,task,onDone}:{apiBase:string;task:{id:string;state:string;taskBudget?:{attemptsUsed:number;attemptsLimit:number;subscriptionRunsUsed:number;subscriptionRunsLimit:number}};onDone:()=>void}) {
  const [note,setNote]=useState("Продолжи эту же задачу с сохранением истории, использованных шагов, квитанций и защиты от повторов. Сначала заново проверь фактическое состояние разрешёнными инструментами. Заверши незакрытые критерии исходного поручения; защищённый пункт не отменяет работу над независимыми разрешёнными пунктами. Старый отчёт и квитанция команды не доказывают сохранённый результат. Не расширяй полномочия и не создавай новую задачу для обнуления бюджета. Работай в пределах оставшихся подписочных шагов, сохрани минимум один шаг общему Приёмщику и передай результат на независимую проверку."),[busy,setBusy]=useState(false),[error,setError]=useState("");
  if(task.state!=="blocked"||!task.taskBudget)return null;
  const budget=task.taskBudget,extra=budget.attemptsUsed>=budget.attemptsLimit;
  return <details><summary>{extra?"Разрешить одну дополнительную попытку":"Продолжить с уточнением"}</summary>
    <p>Использовано попыток: {budget.attemptsUsed}/{budget.attemptsLimit}. Подписочные шаги: {budget.subscriptionRunsUsed}/{budget.subscriptionRunsLimit}.</p>
    <p>{extra?`Предел попыток станет ${budget.attemptsLimit+1}. `:"Выделенная попытка ещё доступна. "}История, использованные шаги и общий подписочный лимит сохранятся. Результат проверит общий Приёмщик.</p>
    <form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setError("");void continueWithAdditionalAttempt(task.id,note,(path,init)=>call(apiBase,path,init)).catch(reason=>setError(reason instanceof Error?reason.message:String(reason))).finally(()=>{setBusy(false);onDone();});}}>
      <textarea aria-label={`Уточнение владельца для ${task.id}`} placeholder="Основание владельца и конкретный следующий шаг исполнителю" rows={5} maxLength={6000} required value={note} onChange={event=>setNote(event.target.value)} />
      <button type="submit" className="secretaryButton" disabled={busy||!note.trim()}>{busy?"Сохраняю решение…":extra?"Разрешить одну попытку и продолжить":"Продолжить с уточнением"}</button>
      {error?<p className="errorBanner" role="alert">{error}</p>:null}
    </form>
  </details>;
}

/** One poller shared by the top bar and the Agents panel. */
const listeners = new Set<(status: AgentOpsStatus | undefined, error: string) => void>();
let pollTimer: number | undefined;
let lastStatus: AgentOpsStatus | undefined;
function startPolling(apiBase: string) {
  if (pollTimer) return;
  void redeemOwnerCode(apiBase).catch(reason => listeners.forEach(listener => listener(lastStatus, reason instanceof Error ? reason.message : String(reason))));
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

export function AgentOpsCard({ apiBase }: { apiBase: string }) {
  const { status, error } = useAgentOpsStatus(apiBase);
  return <div className="appCard cyan"><button className="cardMain" title="Открыть диспетчер задач агентов" onClick={() => { location.href = "/agent-ops"; }}>
    <span className="cardGlow" /><span className="appIcon"><ListChecks /></span>
    <span className="appCopy"><strong>Диспетчер задач агентов</strong><small>Очередь, Приёмщик, доказательства и ресурсы</small></span>
    <span className="cardFooter"><span className={status ? "status on" : "status"}>{status ? `${status.queue.active} незавершённых` : error ? "недоступен" : "подключается"}</span><ArrowUpRight /></span>
  </button></div>;
}

export function AgentOpsPage({ apiBase }: { apiBase: string }) {
  return <main className="launcherPage"><header className="hero"><a className="secretaryButton" href="/"><ArrowLeft /> Мастерская</a><AgentOpsStatusBar apiBase={apiBase} /></header><AgentOpsPanel apiBase={apiBase} /></main>;
}

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
  const owner = (status as AgentOpsStatus & { identity?: { kind: string } }).identity?.kind === "owner";
  const waiting = (status.queue.counts.queued ?? 0) + (status.queue.counts.waiting_window ?? 0) + (status.queue.counts.waiting_resources ?? 0) + (status.queue.counts.waiting_executor ?? 0);
  const attention = (status.queue.counts.blocked ?? 0) + (status.queue.counts.unknown_outcome ?? 0) + (status.queue.counts.awaiting_verification ?? 0);
  const gpu = status.resources?.gpu;
  return <div className={`opsBar mode-${status.mode.mode}`} title={localError || error || `${status.mode.reason} · ${status.mode.localTime} МСК`}>
    {!owner ? <button type="button" className="opsLogin" onClick={() => void requestOwnerLogin().catch(reason => setLocalError(reason instanceof Error ? reason.message : String(reason)))}>Войти как владелец</button> : null}
    <label className="opsModeSelect">
      <span className="opsDot" />
      <select aria-label="Режим компьютера" value={status.manual ? status.manual.mode : "schedule"} disabled={busy || !owner} title={owner ? undefined : "Переключает только владелец: войдите"} onChange={event => void setMode(event.target.value)}>
        <option value="schedule">Авто: {status.mode.source === "schedule" ? MODE_LABELS[status.mode.mode] : "фон (по умолчанию)"}</option>
        {(Object.keys(MODE_LABELS) as Mode[]).map(mode => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
      </select>
    </label>
    {gpu ? <span className="opsMetric" title={`GPU загрузка ${gpu.utilizationPercent}%`}><Cpu /> VRAM {gb(gpu.usedMiB)}/{gb(gpu.totalMiB)}</span> : null}
    {status.resources ? <span className="opsMetric">RAM {gb(status.resources.memory.usedMiB)}/{gb(status.resources.memory.totalMiB)}</span> : null}
    <span className="opsMetric" title="Выполняются / ждут / нужен ответ"><ListChecks /> {status.queue.counts.running ?? 0} · {waiting}{attention ? <b className="opsAttention"> · {attention}!</b> : null}</span>
    {status.locks.length ? <span className="opsMetric" title={status.locks.map(lock => `${lock.key} → ${lock.ownerTaskId}`).join("\n")}><Lock /> {status.locks.length}</span> : null}
    {status.executors.filter(executor => ["codex_cli", "claude_code"].includes(executor.id)).map(executor => { const state = executorUsable(executor); return <span key={executor.id} className={`opsMetric ${state.usable ? "" : "warn"}`}
      title={`${executor.label}: ${state.reason} · квота ${executor.ledger.quota.state}${executor.ledger.quota.source ? ` (${executor.ledger.quota.source})` : ""}`}>
      {executor.id === "codex_cli" ? "Codex" : "Claude"} {state.usable ? "✓" : "⏸"}
    </span>; })}
    {status.ownerActivity?.busy ? <span className="opsMetric warn" title={status.ownerActivity.reasons.join("\n")}>{status.ownerActivity.confidence === "unknown" ? "нагрузка ?" : "компьютер занят"}</span>
      : status.ownerActivity?.signals.length ? <span className="opsMetric" title={status.ownerActivity.signals.join("\n")}>приложения простаивают</span> : null}
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
    {task.lastDecision ? <p className="secretaryContext"><strong>Приёмщик: {DECISIONS[task.lastDecision.decision] ?? task.lastDecision.decision}</strong> · попытка {task.lastDecision.attempt} · {task.lastDecision.criteria.filter(c => c.status === "confirmed").length}/{task.criteria?.length ?? task.lastDecision.criteria.length} критериев подтверждено</p> : null}
    {task.nextStep ? <p className="secretaryContext">Следующий шаг: {task.nextStep}</p> : null}
    <p className="secretaryContext">{task.taskBudget ? `Попыток исполнения: ${task.taskBudget.attemptsUsed}/${task.taskBudget.attemptsLimit} · подписочные запуски: ${task.taskBudget.subscriptionRunsUsed}/${task.taskBudget.subscriptionRunsLimit} · время: ${task.taskBudget.wallMinutesUsed}/${task.taskBudget.wallMinutesLimit} мин · расходы API: ${task.taskBudget.providerCost}` : `Попыток: ${task.attempts}`}{task.nextAttemptAt && !TERMINAL.has(task.state) ? ` · повтор не раньше ${new Date(task.nextAttemptAt).toLocaleTimeString("ru-RU")}` : ""}</p>
    <div className="secretaryMeta"><span>{task.id} · {task.agentId}{task.executor ? ` → ${task.executor}` : ""}{task.depth > 1 ? ` · глубина ${task.depth}` : ""}</span><span>{new Date(task.updatedAt).toLocaleString("ru-RU")}</span></div>
    <div className="opsActions">
      <button type="button" className="secretaryButton" onClick={() => setOpen(open === task.id ? undefined : task.id)}><FileText /> {open === task.id ? "Скрыть" : "Результат и журнал"}</button>
      {!TERMINAL.has(task.state) ? <button type="button" className="secretaryButton" disabled={action === `cancel:${task.id}`} onClick={() => void act(`cancel:${task.id}`, () => call(apiBase, `/tasks/${task.id}/cancel`, { method: "POST", body: "{}" }))}><Ban /> Отменить</button> : null}
      {!TERMINAL.has(task.state) ? <button type="button" className="secretaryButton" disabled={Boolean(action)} onClick={() => void act(`pause:${task.id}`, () => call(apiBase, `/tasks/${task.id}/${task.state === "paused" ? "resume" : "pause"}`, { method: "POST", body: "{}" }))}>{task.state === "paused" ? "Возобновить" : "Приостановить"}</button> : null}
      {["blocked", "unknown_outcome"].includes(task.state) ? <>
        <button type="button" className="secretaryButton" onClick={() => void act(`resolve:${task.id}`, () => call(apiBase, `/tasks/${task.id}/resolve`, { method: "POST", body: JSON.stringify({ action: "continue" }) }))}>Продолжить с текущего состояния</button>
        <button type="button" className="secretaryButton" onClick={() => void act(`resolve:${task.id}`, () => call(apiBase, `/tasks/${task.id}/resolve`, { method: "POST", body: JSON.stringify({ action: "mark_failed" }) }))}>Отметить ошибкой</button>
      </> : null}
      {["awaiting_verification", "unknown_outcome"].includes(task.state) ? <button type="button" className="secretaryButton" onClick={() => void act(`resolve:${task.id}`, () => call(apiBase, `/tasks/${task.id}/resolve`, { method: "POST", body: JSON.stringify({ action: "mark_verified", note: "проверено владельцем в Мастерской" }) }))}>Я проверил: принять</button> : null}
    </div>
    <AdditionalAttemptControl apiBase={apiBase} task={task} onDone={()=>{changed();if(open===task.id)void loadDetail(task.id).catch(reason=>setNotice(String(reason)));}} />
    {open === task.id && detail?.task.id === task.id ? <div className="opsDetail">
      {detail.task.contract ? <>
        <p className="secretaryContext"><strong>Ожидаемый результат:</strong> {detail.task.contract.expectedResult} · версия {detail.task.contract.revision}</p>
        <ul className="opsChecks">{detail.task.contract.criteria.map(criterion => { const verdict = detail.task.reviews?.at(-1)?.criteria.find(v => v.criterionId === criterion.id); return <li key={criterion.id} className={verdict?.status === "confirmed" ? "ok" : "bad"}>
          <strong>{criterion.id}: {criterion.description}</strong> ({criterion.required === false ? "необязательный" : "обязательный"}) — {verdict ? VERDICTS[verdict.status] : "ожидает проверки"}
          <p>{verdict?.reason ?? criterion.unverifiableReason ?? `Способ проверки: ${criterion.review}`}</p>
        </li>; })}</ul>
      </> : null}
      {detail.task.evidence?.length ? <details><summary>Независимые доказательства ({detail.task.evidence.length})</summary>{detail.task.evidence.map(item => <div key={item.id} className="secretaryContext">
        <strong>{item.ok ? "✓" : "✗"} {item.criterionId} · попытка {item.attempt}</strong> · {new Date(item.observedAt).toLocaleString("ru-RU")}<p>Источник: {item.source}</p><p>{item.detail}</p>
        {item.content ? <pre className="opsLog">{item.content}</pre> : null}<small>SHA-256: {item.digest}</small>
      </div>)}</details> : null}
      {detail.task.reviews?.length ? <details><summary>Решения Приёмщика ({detail.task.reviews.length})</summary><ol className="opsEvents">{detail.task.reviews.map((review, i) => <li key={i}>{new Date(review.at).toLocaleString("ru-RU")} · попытка {review.attempt} · <strong>{DECISIONS[review.decision]}</strong><p>{review.reason}</p><p>{review.nextStep}</p>{review.reviewer ? <small>{review.reviewer.level} · {review.reviewer.executor} · {review.reviewer.model}</small> : null}</li>)}</ol></details> : null}
      {detail.task.effects?.length ? <details><summary>Внешние действия</summary>{detail.task.effects.map(effect => <p className="secretaryContext" key={effect.key}>{effect.key}: {effect.state} · {effect.detail}</p>)}</details> : null}
      {detail.task.reviewRuns?.length ? <details><summary>Запуски проверяющей модели ({detail.task.reviewRuns.length})</summary>{detail.task.reviewRuns.map((run, i) => <p className="secretaryContext" key={i}>{run.level} · {run.executor} · {run.model ?? "модель не сообщена"} · {run.outcome ?? "выполняется"} {run.error}</p>)}</details> : null}
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
          {executor.coverage && executor.tier === "subscription" ? <small className="opsCoverage">
            Через SnarkRoute сегодня: поручений {executor.coverage.measuredBySnarkRoute.delegatedRuns}, чатов {executor.coverage.measuredBySnarkRoute.chatTurns}, токенов {executor.coverage.measuredBySnarkRoute.inputTokens + executor.coverage.measuredBySnarkRoute.outputTokens}.
            {" "}Провайдер: {executor.coverage.providerReport ? `${executor.coverage.providerReport.usedPercent ?? "?"}% окна тарифа${executor.coverage.providerReport.stale ? " (устарело)" : ""}, ${executor.coverage.providerReport.observedAt ? new Date(executor.coverage.providerReport.observedAt).toLocaleString("ru-RU") : ""}` : "отчёта нет"}.
            {" "}Вне SnarkRoute: не наблюдается. Наши пределы: {executor.coverage.ourLimits.concurrent} одновременно, общий {executor.coverage.ourLimits.sharedSubscriptionConcurrent}{executor.coverage.ourLimits.dailyRuns != null ? `, ${executor.coverage.ourLimits.dailyRuns} в день` : ""}.
          </small> : null}
        </div>)}
        <h3>Занятость компьютера</h3>
        {status.ownerActivity ? <>
          <p className={`secretaryContext ${status.ownerActivity.busy ? "opsBusy" : ""}`}>{status.ownerActivity.busy ? (status.ownerActivity.confidence === "unknown" ? "Нагрузку определить нельзя — тяжёлая фоновая работа ждёт (кроме окна «Компьютер свободен»)." : "Занят: тяжёлая фоновая работа ждёт.") : "Свободен по измерениям."}
            {status.ownerActivity.sampledAt ? ` Замер ${new Date(status.ownerActivity.sampledAt).toLocaleTimeString("ru-RU")}.` : ""}</p>
          {[...status.ownerActivity.reasons, ...status.ownerActivity.signals].map((line, index) => <p key={index} className="secretaryContext">· {line}</p>)}
        </> : null}
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
