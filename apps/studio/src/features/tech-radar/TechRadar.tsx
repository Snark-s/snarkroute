import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Radio, RefreshCw, Search } from "lucide-react";
import type { CapabilityEntry, Decision, Finding, InventoryTool, Job, Project, Research, Snapshot, Source } from "../../../../server/src/services/tech-radar/types";
import "./TechRadar.css";

type PublicSnapshot = Omit<Snapshot, "sources"> & { sources: Omit<Source, "text">[] };
type PublicResearch = Omit<Research, "snapshot"> & { snapshot: PublicSnapshot };
type PublicProject = Omit<Project, "research"> & { research: PublicResearch[]; researchCount: number };
type PublicJob = Omit<Job, "snapshot"> & { savedSourceCount?: number; snapshot?: PublicSnapshot };
type CatalogResponse = { projects: PublicProject[]; jobs: PublicJob[]; inventory: InventoryTool[]; capabilities: CapabilityEntry[] };
const labels: Record<string, string> = { skip: "Пропустить", watch: "Следить", test: "Испытать", implement: "Внедрить", review_integration: "Рассмотреть внедрение", queued: "В очереди", fetching: "Читаем GitHub", analysing: "Анализируем и сравниваем", completed: "Готово", failed: "Ошибка" };
const evidence = { declared: "Заявлено", documented: "Подтверждено документацией", local_test: "Проверено локально" };
const kinds = { fact: "Сведения источника", claim: "Заявление разработчика", inference: "Интерпретация", unknown: "Неизвестно" };
const date = (value?: string | null) => value ? new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "Неизвестно";
const actions = [["skip", "Пропустить"], ["watch", "Следить"], ["test", "Подготовить тест"], ["review_integration", "Внедрение рассмотреть отдельно"]] as const;

export function TechRadar({ apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317" }: { apiBase?: string }) {
  const [catalog, setCatalog] = useState<CatalogResponse>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<{ project: PublicProject; jobs: PublicJob[] }>();
  const [researchId, setResearchId] = useState<string>();
  const [url, setUrl] = useState(""); const [search, setSearch] = useState(""); const [filter, setFilter] = useState("all");
  const [view, setView] = useState<"projects" | "capabilities">("projects");
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const request = useCallback(async <T,>(path: string, body?: unknown, method = "POST"): Promise<T> => {
    const response = await fetch(`${apiBase}/api/tech-radar${path}`, body === undefined ? { credentials: "include" } : { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? `Технорадар API недоступен (${response.status}). Серверу нужна обновлённая версия кода.`); }
    return response.json();
  }, [apiBase]);
  const refresh = useCallback(async () => {
    setCatalog(await request<CatalogResponse>(""));
    if (selectedId) setDetail(await request(`/projects/${selectedId}`));
  }, [request, selectedId]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (alive) await refresh(); } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Не удалось загрузить каталог"); }
      if (alive) timer = setTimeout(poll, 3000);
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [refresh]);
  async function action(work: () => Promise<void>) { setBusy(true); setError(""); try { await work(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function submit(link = url, repeat = false) {
    await action(async () => {
      const result = await request<{ projectId: string; duplicate: boolean }>("/projects", { url: link, repeat });
      setSelectedId(result.projectId); setResearchId(undefined); setUrl("");
      setNotice(result.duplicate ? "Проект уже в каталоге или очереди. Для нового анализа нажмите «Повторно исследовать»." : "Исследование добавлено в очередь.");
    });
  }
  function select(id: string) { setSelectedId(id); setDetail(undefined); setResearchId(undefined); setNote(""); setNotice(""); }
  async function decide(status: Decision) {
    if (!selectedId) return;
    await action(async () => { await request(`/projects/${selectedId}/decisions`, { status, note }); setNote(""); setNotice(status === "test" ? "Решение сохранено. План проверки доступен в карточке; эксперимент не запускался." : "Решение сохранено."); });
  }
  const selected = detail && detail.project.id === selectedId ? detail.project : catalog?.projects.find(p => p.id === selectedId);
  const research = selected?.research.find(r => r.id === researchId) ?? selected?.research.at(-1);
  const projects = useMemo(() => catalog?.projects.filter(p => {
    const latest = p.research.at(-1); const haystack = `${p.name} ${p.canonicalUrl} ${latest?.analysis.description.text ?? ""} ${latest?.analysis.capabilities.map(c => c.name).join(" ") ?? ""}`.toLocaleLowerCase();
    return haystack.includes(search.toLocaleLowerCase()) && (filter === "all" || (filter === "new" ? latest?.comparison.some(c => c.newToCatalog) : (p.decisions.at(-1)?.status ?? latest?.recommendation.status) === filter));
  }) ?? [], [catalog, search, filter]);
  const queue = useMemo(() => {
    const seen = new Set<string>();
    return [...(catalog?.jobs ?? [])].reverse().filter(job => { if (seen.has(job.projectId)) return false; seen.add(job.projectId); return true; }).slice(0, 12);
  }, [catalog]);
  return <main className="techRadar">
    <header className="trHeader"><a href="/" className="trBack"><ArrowLeft size={17} /> К рабочему столу</a><div><h1><Radio size={26} /> Технорадар</h1><p>Коллекционируем возможности мастерской</p></div><span className="trPill">GitHub · анализ по подписке · без установок</span></header>
    <form className="trIntake" onSubmit={e => { e.preventDefault(); void submit(); }}><label htmlFor="tr-url">GitHub-проект</label><div><input id="tr-url" type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/project" /><button disabled={busy || !url.trim()}>Исследовать</button></div><small>Читаем публичные источники, сравниваем с каталогом и готовим решение. Код проектов не выполняется.</small></form>
    {error && <div className="trAlert" role="alert">{error}<button type="button" onClick={() => void action(refresh)}>Обновить</button></div>}
    {notice && <p role="status" className="trNotice">{notice}</p>}
    <section className="trQueue" aria-label="Очередь исследований"><h2>Очередь исследований</h2>{!catalog ? <p>Загружаем каталог…</p> : !queue.length ? <p>Пока пусто. Добавьте первый GitHub-проект.</p> : <div>{queue.map(job => <button key={job.id} type="button" onClick={() => select(job.projectId)} className={`trJob tr-${job.status}`}><strong>{catalog.projects.find(p => p.id === job.projectId)?.name}</strong><span>{labels[job.status]}</span><small>{job.error ?? date(job.updatedAt)}</small>{!!job.savedSourceCount && <small>Источников сохранено: {job.savedSourceCount}</small>}</button>)}</div>}</section>
    <div className="trTabs"><button type="button" aria-pressed={view === "projects"} onClick={() => setView("projects")}>Проекты ({catalog?.projects.length ?? 0})</button><button type="button" aria-pressed={view === "capabilities"} onClick={() => setView("capabilities")}>Карта возможностей</button></div>
    {view === "capabilities" ? <section className="trMap"><h2>Возможности мастерской</h2><p>Реестр содержит заявленные функции. Их локальная работоспособность не проверялась. Пустая строка означает отсутствие сведений в каталоге.</p><div className="trMapGrid">{catalog?.capabilities.map(c => <article key={c.id}><h3>{c.name}</h3>{c.providers.length ? c.providers.map(p => <p key={p.id}><strong>{p.name}</strong> · {p.local ? "В реестре мастерской" : "Изученный проект"}<small>{evidence[p.evidence]}</small></p>) : <p className="trMuted">Пока нет подтверждений в каталоге</p>}</article>)}</div></section> : <div className="trWorkspace">
      <aside className="trCatalog"><h2>Каталог проектов</h2><label className="trSearch"><Search size={16} /><input aria-label="Поиск проектов и возможностей" value={search} onChange={e => setSearch(e.target.value)} placeholder="Название или возможность" /></label><select aria-label="Фильтр решения" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Все решения</option><option value="new">Есть новые возможности</option>{actions.map(([s]) => <option key={s} value={s}>{labels[s]}</option>)}</select>{!projects.length && <p>Проекты не найдены.</p>}{projects.map(p => <button className={`trProject ${selectedId === p.id ? "active" : ""}`} key={p.id} type="button" onClick={() => select(p.id)}><strong>{p.name}{p.notification && !p.notification.seen ? " ●" : ""}</strong><span>{p.research.at(-1)?.analysis.description.text ?? "Ожидает исследования"}</span><small>{labels[p.decisions.at(-1)?.status ?? p.research.at(-1)?.recommendation.status ?? "queued"]} · исследований: {p.researchCount}</small></button>)}</aside>
      <section className="trDetail" aria-label="Карточка проекта">{!selected ? <div className="trEmpty"><Radio size={46} /><h2>Что умеет новый инструмент?</h2><p>Добавьте ссылку или выберите проект. Здесь появятся источники, пересечения, новые возможности и план проверки.</p></div> : <>
        <div className="trCardTitle"><div><h2>{selected.name}</h2><a href={selected.canonicalUrl} target="_blank" rel="noreferrer">{selected.canonicalUrl} <ExternalLink size={13} /></a><br /><a href="#tr-decision">Принять решение ↓</a></div><button disabled={busy} type="button" onClick={() => void submit(selected.canonicalUrl, true)}><RefreshCw size={14} /> Повторно исследовать</button></div>
        {selected.notification && !selected.notification.seen && <div className="trNotice"><strong>Изменения, способные повлиять на решение</strong><ul>{selected.notification.changes.map((c, i) => <li key={i}>{c}</li>)}</ul><button disabled={busy} type="button" onClick={() => void action(async () => { await request(`/projects/${selected.id}/acknowledge`, {}); })}>Отметить просмотренным</button></div>}
        {!research ? <p>Результат ещё не готов. Статус и ошибки видны в очереди. Уже полученные источники сохраняются.</p> : <>
          <div className="trMeta"><span>Версия: {research.snapshot.version ?? "Неизвестно / релиз не опубликован"}</span><span>Последний push: {date(research.snapshot.updatedAt)}</span><span>Лицензия кода: {research.snapshot.license ?? "Неизвестно"}</span><span>Исследовано: {date(research.completedAt)}</span></div>
          <FindingView finding={research.analysis.description} sources={research.snapshot.sources} />
          <div className="trRecommendation"><small>Рекомендация агента</small><h3>{labels[research.recommendation.status]}</h3><p>{research.recommendation.reason}</p><small>Ваше решение: <strong>{labels[selected.decisions.at(-1)?.status ?? ""] ?? "Ещё не принято"}</strong></small></div>
          <h3>Возможности и пересечения</h3><p className="trMuted">«Новое» означает отсутствие функции в текущем каталоге. Каталог мастерской пока неполный.</p><div className="trCapabilities">{research.analysis.capabilities.map(c => { const comparison = research.comparison.find(item => item.capabilityId === c.id); return <article key={c.id}><h4>{c.name} {comparison?.newToCatalog && <span className="trPill">Новое для каталога</span>}</h4><small>{evidence[c.evidence]}</small><FindingView finding={c.finding} sources={research.snapshot.sources} />{comparison?.overlaps.map(t => <p key={t.id}>Пересечение: <strong>{t.name}</strong> · {t.local ? "реестр мастерской, готовность не проверена" : "изученный проект"} · {evidence[t.evidence]}</p>)}</article>; })}</div>
          {([ ["Практическая ценность", [research.analysis.practicalValue]], ["Доказательства превосходства", [research.analysis.superiority]], ["Оборудование, платформы и зависимости", research.analysis.requirements], ["Интеграция со SnarkRoute / SnarkBridge и отдельная установка", research.analysis.integration], ["Лицензии кода, весов и коммерческое применение", research.analysis.licensing], ["Зрелость и активность разработки", research.analysis.maturity], ["Ограничения и риски", research.analysis.risks] ] as Array<[string, Finding[]]>).map(([title, findings]) => <details className="trAnalysisSection" key={title} open={title === "Практическая ценность"}><summary>{title}</summary>{findings.map((f, i) => <FindingView key={i} finding={f} sources={research.snapshot.sources} />)}</details>)}
          <details className="trTestPlan"><summary>План проверки</summary><p>{research.analysis.testPlan.goal}</p>{([ ["Шаги", "steps"], ["Критерии успеха", "success"], ["Ресурсы", "resources"], ["Риски", "risks"], ["Изоляция и удаление", "cleanup"] ] as const).map(([title, key]) => <div key={key}><strong>{title}</strong><ol>{research.analysis.testPlan[key].map((s, i) => <li key={i}>{s}</li>)}</ol></div>)}<small>План не запускает установку или генерацию. Эксперимент требует отдельного разрешения.</small></details>
          <details><summary>Источники и границы исследования ({research.snapshot.sources.length})</summary><ul>{research.snapshot.sources.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>)}</ul>{research.snapshot.warnings.map((w, i) => <p key={i}>{w}</p>)}<small>Модель: {research.model.provider} / {research.model.model}. Стоимость API: {research.model.providerCost}. Используется подписка.</small></details>
        </>}
        <section id="tr-decision" className="trDecision"><h3>Ваше решение</h3><label>Комментарий<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={4000} placeholder="Почему принимаем это решение" /></label><div>{actions.map(([status, label]) => <button type="button" key={status} disabled={busy || (status === "test" && !research)} onClick={() => void decide(status)}>{label}</button>)}</div><label className="trWatch"><input type="checkbox" checked={selected.watch.enabled} disabled={busy} onChange={e => { const enabled = e.target.checked; void action(async () => { await request(`/projects/${selected.id}/watch`, { enabled, intervalDays: selected.watch.intervalDays }, "PATCH"); }); }} /> Периодически проверять проекты с решением «Следить»</label><label>Интервал, дней <select aria-label="Интервал повторной проверки" value={selected.watch.intervalDays} disabled={busy} onChange={e => { const intervalDays = Number(e.target.value); void action(async () => { await request(`/projects/${selected.id}/watch`, { enabled: selected.watch.enabled, intervalDays }, "PATCH"); }); }}>{[1, 7, 14, 30].map(d => <option key={d} value={d}>{d}</option>)}</select></label><small>По умолчанию выключено. Проверка работает при запущенном SnarkRoute; уведомления появляются здесь только при существенных изменениях.</small></section>
        <details><summary>История исследований и решений</summary>{selected.research.map(r => <p key={r.id}><button type="button" onClick={() => setResearchId(r.id)}>{date(r.completedAt)} · {labels[r.recommendation.status]}</button>{r.changes.length ? r.changes.join("; ") : " Существенных изменений нет / первое исследование"}</p>)}{selected.decisions.map((d, i) => <p key={i}>{date(d.at)} · <strong>{labels[d.status]}</strong>{d.note ? ` — ${d.note}` : ""}</p>)}</details>
        {detail?.jobs.filter(j => j.status === "failed").map(j => <details key={j.id}><summary>Ошибка исследования {date(j.updatedAt)}</summary><p>{j.error}</p>{j.snapshot?.sources.map(s => <p key={s.id}><a href={s.url} target="_blank" rel="noreferrer">Сохранённый источник: {s.title}</a></p>)}</details>)}
      </>}</section>
    </div>}
  </main>;
}
function FindingView({ finding, sources }: { finding: Finding; sources: Omit<Source, "text">[] }) {
  return <div className="trFinding"><small>{kinds[finding.kind]}</small><p>{finding.text}</p>{finding.citations.length > 0 && <details><summary>Основание в первоисточнике</summary>{finding.citations.map((c, i) => { const source = sources.find(s => s.id === c.sourceId); return <blockquote key={i}><p>{c.quote}</p>{source && <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>}</blockquote>; })}</details>}</div>;
}
