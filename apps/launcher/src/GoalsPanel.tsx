import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Flag, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { ownerHeaders } from "./AgentOpsPanel";

type Stage = { id: string; title: string; state: string; reason: string; after: string[]; agentId: string; updatedAt: string };
type Progress = { total: number; verified: number; failed: number; cancelled: number; active: number; needsOwner: number; percent: number; status: string };
type Goal = { id: string; title: string; description?: string; source: string; createdBy: string; assignee: string; state: "active" | "done" | "cancelled"; priority: number; deadline?: string; createdAt: string; updatedAt: string; note?: string; progress: Progress; stages: Stage[] };
type Projected = { system: string; externalId: string; title: string; state: string; detail?: string; progress?: string; updatedAt: string };
const PROJECTED: Record<string, string> = { needs_owner: "нужен ты", stalled: "застряло", active: "в работе", waiting: "ждёт", failed: "не вышло", done: "готово" };
type Letter = { id: string; from: string; subject: string; body: string; at: string; taskId?: string; goalId?: string };
type Report = { id: string; at: string; goalId?: string; kind: string; text: string };
type Task = { id: string; title: string; state: string; reason: string; agentId: string; updatedAt: string; spec: { goalId?: string } };

const STATE: Record<string, string> = {
  queued: "в очереди", waiting_window: "ждёт окна", waiting_resources: "ждёт ресурсов", waiting_executor: "ждёт исполнителя", running: "в работе",
  awaiting_verification: "на приёмке", verified: "принято", failed: "не вышло", cancelled: "отменено", blocked: "нужен ты", paused: "на паузе", unknown_outcome: "исход неясен"
};
const STATUS: Record<string, string> = { no_stages: "этапов пока нет", in_progress: "в работе", needs_owner: "нужен ты", all_accepted: "все этапы приняты", stalled: "застряла" };
const SOURCE: Record<string, string> = { workshop: "Мастерская", chatgpt: "ChatGPT", telegram: "Telegram", agent: "агент", mcp: "MCP" };
const TERMINAL = new Set(["verified", "failed", "cancelled"]);

async function call<T>(apiBase: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}/api/agent-ops${path}`, {
    method, headers: { ...await ownerHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok) throw new Error(data.error || (response.status === 401 ? "Нужен вход владельца в Мастерской." : "SnarkRoute не ответил."));
  return data;
}

/** D6: one picture of what is in work — goals with their stages, and every active task of the shared queue. */
export function GoalsPanel({ apiBase }: { apiBase: string }) {
  const [goals, setGoals] = useState<Goal[]>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [letters, setLetters] = useState<Letter[]>([]);
  const [work, setWork] = useState<{ items: Projected[]; sources: Record<string, { label: string; ok: boolean; error?: string }> }>({ items: [], sources: {} });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [goalList, taskList, secretary] = await Promise.all([call<{ goals: Goal[] }>(apiBase, "/goals?limit=200"), call<{ tasks: Task[] }>(apiBase, "/tasks?limit=300"),
        call<{ reports: Report[] }>(apiBase, "/secretary").catch(() => ({ reports: [] as Report[] }))]);
      const [inbox, registry] = await Promise.all([call<{ letters: Letter[] }>(apiBase, "/mail?unacknowledged=1").catch(() => ({ letters: [] as Letter[] })),
        call<{ items: Projected[]; sources: Record<string, { label: string; ok: boolean; error?: string }> }>(apiBase, "/registry").catch(() => ({ items: [] as Projected[], sources: {} }))]);
      if (!mounted.current) return;
      setGoals(goalList.goals); setTasks(taskList.tasks); setReports(secretary.reports); setLetters(inbox.letters); setWork(registry); setError("");
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Не удалось прочитать реестр."); }
  }, [apiBase]);

  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);

  async function act(key: string, run: () => Promise<string>) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { const message = await run(); if (mounted.current) setNotice(message); await refresh(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Не получилось."); }
    finally { if (mounted.current) setBusy(""); }
  }
  const create = () => act("create", async () => {
    const text = [title.trim(), description.trim()].filter(Boolean).join("\n");
    await call(apiBase, "/secretary/messages", "POST", { text, source: "workshop", requestKey: `workshop:${Date.now()}` });
    setTitle(""); setDescription("");
    return `Секретарь принял цель «${title.trim()}»: раскладывает её на этапы и раздаёт очереди.`;
  });
  const close = (goal: Goal, state: "done" | "cancelled") => act(goal.id, async () => {
    await call(apiBase, `/goals/${goal.id}/close`, "POST", { state });
    return state === "done" ? `Цель «${goal.title}» закрыта как достигнутая.` : `Цель «${goal.title}» отменена вместе с незавершёнными этапами.`;
  });

  const active = (goals ?? []).filter(goal => goal.state === "active");
  const closed = (goals ?? []).filter(goal => goal.state !== "active");
  const loose = tasks.filter(task => !task.spec.goalId && !TERMINAL.has(task.state));

  return <section className="secretaryWorkspace goalsPanel">
    <header className="secretaryHeader">
      <div><h2>Задачи</h2><p>Скажи цель — Секретарь разложит её на этапы и раздаст очереди. Процент считается только по этапам, которые принял Приёмщик.</p></div>
      <button type="button" className="secretaryButton" onClick={() => void refresh()} disabled={Boolean(busy)}><RefreshCw /> Обновить</button>
    </header>
    {error ? <div className="errorBanner" role="alert">{error}</div> : null}
    {notice ? <div className="successBanner" role="status">{notice}</div> : null}
    <form className="secretaryForm goalForm" onSubmit={event => { event.preventDefault(); void create(); }}>
      <input placeholder="Новая цель: что должно получиться" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} disabled={Boolean(busy)} />
      <textarea placeholder="Подробности, ограничения, критерий «готово» (необязательно)" value={description} rows={2} onChange={event => setDescription(event.target.value)} disabled={Boolean(busy)} />
      <button type="submit" className="secretaryButton primary" disabled={Boolean(busy) || !title.trim()}>{busy === "create" ? <LoaderCircle className="spin" /> : <Plus />} Поставить цель</button>
    </form>
    <p className="secretarySummary"><strong>{active.length}</strong> целей в работе · <strong>{loose.length}</strong> задач вне целей</p>
    {goals && !active.length ? <div className="secretaryEmpty"><CheckCircle2 /> Активных целей нет.</div> : null}
    {active.map(goal => <GoalCard key={goal.id} goal={goal} busy={busy} onClose={state => void close(goal, state)} />)}
    {letters.length ? <details className="secretaryArchive" open>
      <summary>Письма тебе ({letters.length})</summary>
      <div className="secretaryArchiveList">{letters.map(letter => <article key={letter.id} className="secretaryQuestion">
        <div className="secretaryMeta"><strong>{letter.subject}</strong><span>{letter.from} · {new Date(letter.at).toLocaleString("ru-RU")}{letter.taskId ? ` · ${letter.taskId}` : ""}{letter.goalId ? ` · ${letter.goalId}` : ""}</span></div>
        <p className="secretaryContext">{letter.body}</p>
        <div className="secretaryForm"><button type="button" className="secretaryButton" disabled={Boolean(busy)} onClick={() => void act(letter.id, async () => { await call(apiBase, `/mail/${letter.id}/ack`, "POST", {}); return "Получение подтверждено."; })}><CheckCircle2 /> Прочитано</button></div>
      </article>)}</div>
    </details> : null}
    {reports.length ? <details className="secretaryArchive" open>
      <summary>Отчёты Секретаря ({reports.length})</summary>
      <div className="secretaryArchiveList">{reports.slice(0, 30).map(report => <div key={report.id} className={`goalStage report-${report.kind}`}>
        <span className="goalStageState">{new Date(report.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
        <span className="goalStageTitle">{report.text}</span>
      </div>)}</div>
    </details> : null}
    {work.items.length || Object.keys(work.sources).length ? <details className="secretaryArchive" open>
      <summary>Работа других агентов ({work.items.length}){Object.values(work.sources).some(source => !source.ok) ? ` · недоступно: ${Object.values(work.sources).filter(source => !source.ok).map(source => source.label).join(", ")}` : ""}</summary>
      <div className="secretaryArchiveList">{work.items.map(item => <div key={`${item.system}/${item.externalId}`} className={`goalStage state-${item.state === "needs_owner" ? "blocked" : item.state}`}>
        <span className="goalStageState">{PROJECTED[item.state] ?? item.state}</span>
        <span className="goalStageTitle">{work.sources[item.system]?.label ?? item.system}: {item.title}{item.progress ? ` · ${item.progress}` : ""}</span>
        {item.detail ? <small>{item.detail}</small> : null}
      </div>)}</div>
    </details> : null}
    {loose.length ? <details className="secretaryArchive" open>
      <summary>Задачи очереди вне целей ({loose.length})</summary>
      <div className="secretaryArchiveList">{loose.map(task => <StageRow key={task.id} stage={{ ...task, after: [] }} />)}</div>
    </details> : null}
    {closed.length ? <details className="secretaryArchive">
      <summary>Закрытые цели ({closed.length})</summary>
      <div className="secretaryArchiveList">{closed.map(goal => <GoalCard key={goal.id} goal={goal} busy={busy} />)}</div>
    </details> : null}
  </section>;
}

function GoalCard({ goal, busy, onClose }: { goal: Goal; busy: string; onClose?: (state: "done" | "cancelled") => void }) {
  const { progress } = goal;
  return <article className={`secretaryQuestion goalCard ${progress.status}`}>
    <div className="secretaryMeta"><strong><Flag /> {goal.title}</strong><span>{SOURCE[goal.source] ?? goal.source} · {goal.assignee} · {new Date(goal.createdAt).toLocaleDateString("ru-RU")}</span></div>
    {goal.description ? <p className="secretaryContext">{goal.description}</p> : null}
    <div className="goalProgress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress.percent}%` }} /></div>
    <p className="secretaryContext">{goal.state === "active" ? STATUS[progress.status] ?? progress.status : goal.state === "done" ? "достигнута" : "отменена"} · принято {progress.verified} из {progress.total - progress.cancelled}{progress.failed ? ` · не вышло ${progress.failed}` : ""}{progress.needsOwner ? ` · ждут тебя ${progress.needsOwner}` : ""}{goal.note ? ` · ${goal.note}` : ""}</p>
    {goal.stages.length ? <div className="goalStages">{goal.stages.map(stage => <StageRow key={stage.id} stage={stage} />)}</div> : null}
    {onClose ? <div className="secretaryForm">
      <button type="button" className="secretaryButton" disabled={Boolean(busy) || progress.active > 0} title={progress.active ? "Есть незавершённые этапы" : undefined} onClick={() => onClose("done")}><CheckCircle2 /> Достигнута</button>
      <button type="button" className="secretaryButton" disabled={Boolean(busy)} onClick={() => onClose("cancelled")}><X /> Отменить</button>
    </div> : null}
  </article>;
}

function StageRow({ stage }: { stage: Stage }) {
  return <div className={`goalStage state-${stage.state}`}>
    <span className="goalStageState">{STATE[stage.state] ?? stage.state}</span>
    <span className="goalStageTitle" title={stage.id}>{stage.title}</span>
    <small>{stage.agentId}{stage.after.length ? ` · после ${stage.after.join(", ")}` : ""} · {stage.reason}</small>
  </div>;
}
