import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ArrowRight, ArrowUpRight, Brain, CheckCircle2, Circle, Clock3, FolderOpen, Hexagon, LoaderCircle, Music, Paperclip, Plus, Route, Send, Sparkles, Square, Trash2, Wand2, X } from "lucide-react";
import "./styles.css";

const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";

type AppCard = { id: string; name: string; description: string; url: string; running: boolean; status?: string; generating?: boolean; error?: string; accent: string; icon: string };
type ProviderRoute = { provider: string; providerModelId: string; storedModelId?: string; inputTypes?: string[]; availability?: { status?: string; configured?: boolean } };
type Model = { id: string; canonicalModelId?: string; displayName: string; inputTypes?: string[]; providerRoutes?: ProviderRoute[] };
type Task = { task_id: string; objective: string; display_title?: string; status: string; phase: string; updated_at: string; last_response?: string; pending_action?: unknown; last_codex_handoff?: unknown; step: number };
type Project = { project_id: string; name: string; available: boolean; resources: Array<{ role: string; available: boolean; resolved_path?: string }> };
type ImageAttachment = { id: string; name: string; mimeType: string; dataBase64: string };
type ProgressEvent = { at: string; kind: string; message: string };
type RunJob = { jobId: string; taskId: string; status: "running" | "complete" | "failed" | "cancelled"; events: ProgressEvent[]; updatedAt: string; startedAt?: string; result?: { state?: Task }; error?: string };

const iconMap = { sparkles: Sparkles, route: Route, wand: Wand2, hexagon: Hexagon, brain: Brain, music: Music };

function App() {
  return location.pathname.startsWith("/persona") ? <PersonaAgent /> : <Launcher />;
}

function Launcher() {
  const [apps, setApps] = useState<AppCard[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const refresh = async () => setApps((await api<{ apps: AppCard[] }>("/api/system/apps")).apps);
  useEffect(() => {
    document.title = "Мастерская";
    const link = ensureFavicon();
    link.type = "image/png";
    link.href = "/launcher-icon.png";
  }, []);
  useEffect(() => { void refresh().catch((reason) => setError(message(reason))); }, []);

  async function openApp(app: AppCard) {
    setBusy(app.id); setError("");
    const popup = window.open("about:blank", `snarkroute-${app.id}`);
    try {
      const result = await api<{ url: string; started: boolean }>(`/api/system/apps/${encodeURIComponent(app.id)}/open`, { method: "POST" });
      if (popup) popup.location.href = result.url; else location.href = result.url;
      window.setTimeout(() => void refresh(), 1400);
    } catch (reason) {
      popup?.close(); setError(message(reason));
    } finally { setBusy(""); }
  }

  async function yueAction(action: "stop" | "outputs") {
    setBusy(`yue2-${action}`); setError("");
    try { await api(`/api/system/apps/yue2/${action}`, { method: "POST" }); await refresh(); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  return <main className="launcherPage">
    <header className="hero">
      <div className="launcherBrand"><img src="/launcher-icon.png" alt="" /><div><span className="eyebrow">Локальная мастерская</span><p>Один вход во все инструменты. SnarkRoute уже держит модели и плагины на связи.</p></div></div>
      <div className="runtimePill"><span className="pulse" /> SnarkRoute работает</div>
    </header>
    {error ? <div className="errorBanner">{error}</div> : null}
    <section className="appGrid">
      {apps.map((app, index) => {
        const Icon = iconMap[app.icon as keyof typeof iconMap] ?? Sparkles;
        return <div key={app.id} className={`appCard ${app.accent}`} style={{ animationDelay: `${index * 55}ms` }}>
          <button className="cardMain" onClick={() => void openApp(app)}>
          <span className="cardGlow" /><span className={`appIcon ${app.icon.startsWith("/") ? "branded" : ""}`}>{app.icon.startsWith("/") ? <img src={app.icon} alt="" /> : <Icon />}</span>
          <span className="appCopy"><strong>{app.name}</strong><small>{app.description}</small></span>
          <span className="cardFooter"><span className={app.running ? "status on" : "status"}>{app.running ? <CheckCircle2 /> : <Circle />}{app.id === "yue2" ? yueStatus(app) : app.running ? "открыто" : "готово"}</span>{busy === app.id ? <LoaderCircle className="spin" /> : <ArrowUpRight />}</span>
          </button>
          {app.id === "yue2" ? <span className="cardActions"><button title="Открыть результаты" onClick={() => void yueAction("outputs")} disabled={!app.running}><FolderOpen /> Результаты</button><button title="Остановить YuE2" onClick={() => void yueAction("stop")} disabled={!app.running}><Square /> Остановить</button></span> : null}
        </div>;
      })}
    </section>
  </main>;
}

function yueStatus(app: AppCard) {
  return ({ stopped: "остановлен", starting: "запускается", loading: "загружается", ready: "готов", generating: "генерирует", error: "ошибка" } as Record<string, string>)[app.status ?? "stopped"] ?? app.status;
}

function PersonaAgent() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState("");
  const [routeKey, setRouteKey] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [objective, setObjective] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const conversation = useRef<HTMLElement>(null);
  const [allowWrite, setAllowWrite] = useState(true);
  const [allowShell, setAllowShell] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activity, setActivity] = useState<ProgressEvent[]>([]);
  const [activityTaskId, setActivityTaskId] = useState("");
  const [jobId, setJobId] = useState("");
  const [jobStatus, setJobStatus] = useState<RunJob["status"] | "">("");
  const [stopping, setStopping] = useState(false);
  const monitoringJob = useRef("");
  const active = tasks.find((task) => task.task_id === activeId);
  const model = models.find((item) => item.id === modelId);
  const routes = useMemo(() => (model?.providerRoutes ?? []).filter((route) => {
    const available = route.availability?.status !== "unavailable" && route.availability?.configured !== false;
    return available && (!attachments.length || acceptsImages(route.inputTypes ?? model?.inputTypes));
  }), [model, attachments.length]);
  const routeSignature = routes.map((route) => `${route.provider}\u0000${route.providerModelId}`).join("\u0001");
  const selectedRoute = routes.find((route) => `${route.provider}\u0000${route.providerModelId}` === routeKey);

  async function load() {
    const [taskData, modelData, projectData] = await Promise.all([
      api<{ tasks: Task[] }>("/api/persona/tasks"),
      api<{ models: Model[] }>("/api/models/for-node/ai.text"),
      api<Project[]>("/api/persona/projects")
    ]);
    setTasks(taskData.tasks); setModels(modelData.models); setProjects(projectData);
    setActiveId((value) => value || taskData.tasks[0]?.task_id || "");
    setModelId((value) => value || modelData.models.find((item) => item.providerRoutes?.some((route) => route.availability?.configured !== false))?.id || modelData.models[0]?.id || "");
    setWorkspace((value) => value || projectData.flatMap((project) => project.resources).find((resource) => resource.available)?.resolved_path || "");
  }
  useEffect(() => {
    let disposed = false;
    void (async () => {
      await load();
      const data = await api<{ jobs: RunJob[] }>("/api/persona/jobs");
      if (disposed || !data.jobs.length) return;
      const job = [...data.jobs].sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))[0];
      await monitorJob(job.jobId, job.taskId);
    })().catch((reason) => { if (!disposed) setError(message(reason)); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    const link = ensureFavicon();
    if (busy !== "run") {
      document.title = "Jabberwock";
      link.type = "image/png";
      link.href = "/jabberwock-icon.png";
      return;
    }
    document.title = "● Jabberwock — работает";
    let frame = 0;
    const tick = () => { link.type = "image/svg+xml"; link.href = busyFavicon(frame++); };
    tick();
    const timer = window.setInterval(tick, 350);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (routes.some((route) => `${route.provider}\u0000${route.providerModelId}` === routeKey)) return;
    const first = routes[0]; setRouteKey(first ? `${first.provider}\u0000${first.providerModelId}` : "");
  }, [modelId, routeSignature]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activity.length, activity.at(-1)?.message, active?.last_response, activeId]);

  async function createTask() {
    if (!objective.trim()) return;
    setBusy("create"); setError("");
    try { const task = await api<Task>("/api/persona/tasks", { method: "POST", body: JSON.stringify({ objective }), headers: jsonHeaders }); setObjective(""); await load(); setActiveId(task.task_id); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function handoff() {
    const taskId = `codex-${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "")}`;
    setBusy("handoff"); setError("");
    try { await api("/api/persona/handoff", { method: "POST", body: JSON.stringify({ taskId }), headers: jsonHeaders }); await load(); setActiveId(taskId); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function continueInCodex() {
    if (!active || !workspace) return;
    setBusy("codex"); setError(""); setNotice("");
    try {
      await api(`/api/persona/tasks/${encodeURIComponent(active.task_id)}/continue-in-codex`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ workspace })
      });
      setNotice("Задача передана. Codex Desktop открывает новую задачу с этим контекстом.");
      await load(); setActiveId(active.task_id);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function returnFromCodex() {
    if (!active) return;
    setBusy("return-codex"); setError("");
    try {
      await api("/api/persona/handoff", {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ taskId: active.task_id, objective: active.objective, matchingTask: true })
      });
      await load(); setActiveId(active.task_id);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function deleteTask(task: Task) {
    if (!window.confirm(`Удалить задачу «${taskTitle(task, 80)}»?\n\nОна исчезнет из списка, но останется в корзине PersonaCore для восстановления.`)) return;
    setBusy(`delete:${task.task_id}`); setError("");
    try {
      await api(`/api/persona/tasks/${encodeURIComponent(task.task_id)}`, { method: "DELETE" });
      const remaining = tasks.filter((item) => item.task_id !== task.task_id);
      setTasks(remaining);
      if (activeId === task.task_id) { setActiveId(remaining[0]?.task_id ?? ""); setPrompt(""); setAttachments([]); }
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function run() {
    if (!active || !model || !selectedRoute) return;
    setBusy("run"); setError(""); setActivityTaskId(active.task_id); setActivity([{ at: new Date().toISOString(), kind: "start", message: "Передаю текущий запрос модели…" }]);
    try {
      const started = await api<{ jobId: string }>(`/api/persona/tasks/${encodeURIComponent(active.task_id)}/run/start`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({
          prompt, model: model.canonicalModelId ?? model.id,
          executionProvider: selectedRoute.provider, providerModelId: selectedRoute.providerModelId,
          workspace, allowWrite, allowShell, maxSteps: 32,
          attachments: attachments.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 }))
        })
      });
      await monitorJob(started.jobId, active.task_id);
    } catch (reason) { setError(message(reason)); setJobStatus("failed"); setBusy(""); }
  }

  async function monitorJob(nextJobId: string, taskId: string) {
    if (monitoringJob.current === nextJobId) return;
    monitoringJob.current = nextJobId;
    setJobId(nextJobId); setJobStatus("running"); setBusy("run"); setActivityTaskId(taskId); setActiveId(taskId);
    try {
      let job: RunJob;
      let failures = 0;
      while (true) {
        try {
          job = await api<RunJob>(`/api/persona/jobs/${encodeURIComponent(nextJobId)}`);
          failures = 0;
          setJobStatus(job.status);
          setActivity(job.events.length ? job.events : [{ at: job.updatedAt, kind: "running", message: "Процесс запущен; ожидаю первый сигнал…" }]);
        } catch (reason) {
          failures += 1;
          if (failures >= 20) throw reason;
          setActivity((current) => current.at(-1)?.kind === "reconnecting" ? current : [...current, {
            at: new Date().toISOString(), kind: "reconnecting", message: "Связь со SnarkRoute пропала. Jabberwock переподключается; задача не забыта.",
          }]);
          await delay(Math.min(5_000, 750 * failures));
          continue;
        }
        if (job.status !== "running") break;
        await delay(850);
      }
      if (job.status === "cancelled") return;
      if (job.status === "failed") throw new Error(job.error || "Jabberwock завершил задачу с ошибкой.");
      if (!job.result?.state) throw new Error("Jabberwock не вернул состояние задачи.");
      setPrompt(""); setAttachments([]); await load(); setActiveId(job.result.state.task_id);
    } finally {
      monitoringJob.current = "";
      setJobId(""); setBusy(""); setStopping(false);
    }
  }

  async function stopRun() {
    if (!jobId || jobStatus !== "running") return;
    setStopping(true); setError("");
    try {
      const job = await api<RunJob>(`/api/persona/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      setJobStatus(job.status); setActivity(job.events);
    } catch (reason) { setError(message(reason)); setStopping(false); }
  }

  async function addImages(files: FileList | File[]) {
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    if (attachments.length + images.length > 8) { setError("К одной задаче можно добавить до 8 изображений за раз."); return; }
    const oversized = images.find((file) => file.size > 10 * 1024 * 1024);
    if (oversized) { setError(`Файл «${oversized.name}» больше 10 МБ.`); return; }
    try {
      const added = await Promise.all(images.map(async (file) => ({
        id: crypto.randomUUID(), name: file.name || "clipboard-image.png", mimeType: file.type,
        dataBase64: await readDataUrl(file)
      })));
      setAttachments((current) => [...current, ...added]); setError("");
    } catch (reason) { setError(message(reason)); }
  }

  function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault(); void addImages(files);
  }

  return <div className="personaPage">
    <aside className="taskRail">
      <a className="backLink" href="/"><ArrowLeft /> Мастерская</a>
      <div className="personaMark"><img src="/jabberwock-icon.png" alt="" /><div><strong>Jabberwock</strong><small>общая память · любой маршрут</small></div></div>
      <button className="handoffButton" onClick={() => void handoff()} disabled={Boolean(busy)}><Sparkles /> Подхватить этот Codex</button>
      <button className="continueCodexButton" onClick={() => void continueInCodex()} disabled={!active || !workspace || Boolean(busy)}>{busy === "codex" ? <LoaderCircle className="spin" /> : <ArrowRight />} Продолжить в Codex</button>
      {active?.last_codex_handoff ? <button className="returnCodexButton" onClick={() => void returnFromCodex()} disabled={Boolean(busy)}>{busy === "return-codex" ? <LoaderCircle className="spin" /> : <ArrowLeft />} Забрать из Codex</button> : null}
      <div className="newTask"><textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Новая задача…" /><button onClick={() => void createTask()} disabled={!objective.trim() || Boolean(busy)}><Plus /> Создать</button></div>
      <div className="taskList">{tasks.map((task) => <div className={`taskListItem ${task.task_id === activeId ? "active" : ""}`} key={task.task_id}><button className="taskSelect" onClick={() => setActiveId(task.task_id)} title={cleanTaskText(task.objective)}><strong>{taskTitle(task, 64)}</strong><small><Clock3 /> {task.phase} · шаг {task.step}</small></button><button className="taskDelete" onClick={() => void deleteTask(task)} disabled={Boolean(busy)} title="Удалить задачу" aria-label={`Удалить задачу ${taskTitle(task, 40)}`}>{busy === `delete:${task.task_id}` ? <LoaderCircle className="spin" /> : <Trash2 />}</button></div>)}</div>
    </aside>
    <main className="agentWorkspace">
      <header><div><span className="eyebrow">Независимый локальный агент</span><h1 title={active ? cleanTaskText(active.objective) : undefined}>{active ? taskTitle(active, 150) : "Выберите или создайте задачу"}</h1></div><span className={`taskState ${active?.status === "complete" ? "complete" : ""}`}>{active?.status ?? "нет задачи"}</span></header>
      {error ? <div className="errorBanner">{error}</div> : null}
      {notice ? <div className="successBanner">{notice}</div> : null}
      <section className="controlPanel">
        <label><span>Модель</span><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
        <label><span>Маршрут SnarkRoute</span><select value={routeKey} onChange={(event) => setRouteKey(event.target.value)}>{routes.map((route) => <option key={`${route.provider}:${route.providerModelId}`} value={`${route.provider}\u0000${route.providerModelId}`}>{route.provider}</option>)}</select></label>
        <label><span>Проект</span><select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>{projects.flatMap((project) => project.resources.filter((resource) => resource.available && resource.resolved_path).map((resource) => <option key={`${project.project_id}:${resource.role}`} value={resource.resolved_path}>{project.name} · {resource.role}</option>))}</select></label>
        <div className="permissions"><label><input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} /> изменять файлы</label><label><input type="checkbox" checked={allowShell} onChange={(event) => setAllowShell(event.target.checked)} /> запускать инструменты</label></div>
      </section>
      <section className="conversation" ref={conversation}>
        {activityTaskId === active?.task_id && (jobStatus || activity.length) ? <aside className={`activityPanel ${jobStatus}`}><div className="activityHeader">{jobStatus === "running" ? <LoaderCircle className="spin" /> : jobStatus === "cancelled" || jobStatus === "failed" ? <X /> : <CheckCircle2 />}<strong>{jobStatus === "running" ? "Jabberwock работает" : jobStatus === "cancelled" ? "Остановлено" : jobStatus === "failed" ? "Завершено с ошибкой" : "Последний запуск завершён"}</strong><small>{activity.at(-1) ? `сигнал ${formatActivityTime(activity.at(-1)!.at)}` : ""}</small></div><div className="activityList">{activity.map((event, index) => <div key={`${event.at}-${index}`} className={`activityEvent ${event.kind}`}><span /> <p>{event.message}</p></div>)}</div></aside> : null}
        {active?.last_response ? <article className="agentReply"><span><Brain /> Jabberwock</span><p>{active.last_response}</p></article> : <div className="emptyAgent"><img src="/jabberwock-icon.png" alt="" /><h2>Контекст готов</h2><p>PersonaCore передаст память и состояние задачи выбранной модели через SnarkRoute.</p></div>}
      </section>
      <footer className="composer">
        {attachments.length ? <div className="attachmentStrip">{attachments.map((attachment) => <div className="attachmentPreview" key={attachment.id}><img src={attachment.dataBase64} alt={attachment.name} /><span>{attachment.name}</span><button type="button" aria-label={`Убрать ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X /></button></div>)}</div> : null}
        <input ref={attachmentInput} className="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { if (event.target.files) void addImages(event.target.files); event.target.value = ""; }} />
        <button className="attachButton" type="button" title="Прикрепить изображение" aria-label="Прикрепить изображение" onClick={() => attachmentInput.current?.click()} disabled={!active || busy === "run"}><Paperclip /></button>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onPaste={pasteImages} placeholder="Что делаем дальше? Вставьте картинку через Ctrl+V" disabled={!active || busy === "run"} />
        {jobStatus === "running" ? <button className="stopButton" onClick={() => void stopRun()} disabled={stopping}>{stopping ? <LoaderCircle className="spin" /> : <X />} {stopping ? "Останавливаю…" : "Остановить"}</button> : <button className="runButton" onClick={() => void run()} disabled={!active || !selectedRoute || Boolean(busy)}><Send /> Выполнить</button>}
        {attachments.length && !selectedRoute ? <div className="imageRouteWarning">У выбранной модели нет доступного маршрута с поддержкой изображений.</div> : null}
      </footer>
    </main>
  </div>;
}

const jsonHeaders = { "Content-Type": "application/json" };
async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}
function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
function acceptsImages(inputTypes?: string[]) { return (inputTypes ?? []).some((type) => type.toLowerCase().includes("image")); }
function readDataUrl(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать изображение.")); reader.readAsDataURL(file); }); }
function delay(milliseconds: number) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
function formatActivityTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "только что" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function ensureFavicon() { let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]'); if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.append(link); } return link; }
function busyFavicon(frame: number) { const angle = (frame % 8) * 45; return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#16101c"/><circle cx="32" cy="32" r="21" fill="none" stroke="#553820" stroke-width="7"/><path d="M32 11a21 21 0 0 1 19 12" fill="none" stroke="#ffc04d" stroke-width="7" stroke-linecap="round" transform="rotate(${angle} 32 32)"/><circle cx="32" cy="32" r="6" fill="#ffb52f"/></svg>`)}`; }
function cleanTaskText(value: string) {
  const decoder = document.createElement("textarea");
  decoder.innerHTML = value;
  const plain = decoder.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const marker = /##\s*My request(?: for Codex)?:\s*/i.exec(plain);
  return marker ? plain.slice(marker.index + marker[0].length).trim() : plain;
}
function taskTitle(task: Task, limit: number) {
  const text = cleanTaskText(task.objective) || cleanTaskText(task.display_title || "");
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit - 1).replace(/\s+\S*$/, "").replace(/[\s,;:—-]+$/, "");
  return `${clipped || text.slice(0, limit - 1)}…`;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
