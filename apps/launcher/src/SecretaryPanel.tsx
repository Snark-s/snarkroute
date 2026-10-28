import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, Send } from "lucide-react";

type Question = { id: string; date: string; agent: string; question: string; suggestions: string; answer: string; note: string; closed: boolean };
type Inbox = { questions: Question[]; pending: number; checkedAt: string };

async function request(apiBase: string, path: string, init?: RequestInit): Promise<Inbox> {
  const response = await fetch(`${apiBase}/api/system/secretary/questions${path}`, { ...init, signal: AbortSignal.timeout(45_000) });
  const body = await response.json() as Inbox & { ok: boolean; error?: string };
  if (!response.ok || !body.ok) throw new Error(body.error || "Не удалось связаться с реестром Секретаря.");
  return body;
}

export function SecretaryPanel({ apiBase, onPendingChange }: { apiBase: string; onPendingChange: (pending: number) => void }) {
  const [inbox, setInbox] = useState<Inbox>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const operation = useRef(false);

  const accept = useCallback((next: Inbox) => { setInbox(next); onPendingChange(next.pending); }, [onPendingChange]);
  const refresh = useCallback(async (fresh = false) => {
    if (operation.current) return;
    operation.current = true;
    if (mounted.current) setRefreshing(true);
    try {
      const next = await request(apiBase, fresh ? "?refresh=1" : "");
      if (mounted.current) { accept(next); setError(""); }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Не удалось обновить вопросы.");
    } finally {
      operation.current = false;
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, [apiBase, accept]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(poll, 30_000);
    window.addEventListener("snarkroute:apps-changed", poll);
    return () => { mounted.current = false; window.clearInterval(timer); window.removeEventListener("snarkroute:apps-changed", poll); };
  }, [refresh]);

  async function answer(question: Question) {
    const text = drafts[question.id]?.trim();
    if (!text || operation.current) return;
    operation.current = true; setSending(question.id); setError(""); setNotice("");
    try {
      const next = await request(apiBase, `/${encodeURIComponent(question.id)}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: text, expectedQuestion: question.question })
      });
      if (mounted.current) {
        accept(next);
        setDrafts(current => { const updated = { ...current }; delete updated[question.id]; return updated; });
        setNotice(`Ответ на вопрос №${question.id} сохранён в реестре.`);
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Не удалось сохранить ответ. Черновик сохранён в этой вкладке.");
    } finally { operation.current = false; if (mounted.current) setSending(""); }
  }

  const pending = inbox?.questions.filter(question => !question.answer && !question.closed) ?? [];
  const archived = inbox?.questions.filter(question => question.answer || question.closed) ?? [];

  return <div className="secretaryWorkspace">
    <header className="secretaryHeader">
      <div><h2>Секретарь</h2><p>Вопросы, на которые нужен твой ответ. Ответ сразу уходит в реестр, его видят Шорёк и агенты.</p></div>
      <button type="button" className="secretaryButton" onClick={() => void refresh(true)} disabled={refreshing || Boolean(sending)}>
        {refreshing ? <LoaderCircle className="spin" /> : <RefreshCw />} Обновить
      </button>
    </header>
    {error ? <div className="errorBanner" role="alert">{error} Черновики ответов остаются в этой вкладке.</div> : null}
    {notice ? <div className="successBanner" role="status">{notice}</div> : null}
    {loading ? <p className="secretarySummary" role="status"><LoaderCircle className="spin" /> Загружаю вопросы из реестра…</p> : null}
    {inbox ? <>
      <p className="secretarySummary"><strong>{inbox.pending}</strong> ждут ответа</p>
      {!pending.length ? <div className="secretaryEmpty"><CheckCircle2 /> Все вопросы разобраны. Новые появятся здесь автоматически.</div> : null}
      {pending.map((question, index) => <article className="secretaryQuestion" key={`${question.id}-${index}`}>
        <div className="secretaryMeta"><strong>№{question.id} · {question.agent || "Агент"}</strong><span>{question.date}</span></div>
        <h3>{question.question}</h3>
        {question.suggestions ? <p className="secretaryContext">Варианты: {question.suggestions}</p> : null}
        {question.note ? <p className="secretaryContext">{question.note}</p> : null}
        <form className="secretaryForm" onSubmit={event => { event.preventDefault(); void answer(question); }}>
          <label htmlFor={`secretary-answer-${question.id}-${index}`}>Твой ответ</label>
          <textarea id={`secretary-answer-${question.id}-${index}`} rows={3} maxLength={10_000} value={drafts[question.id] ?? ""}
            disabled={sending === question.id} onChange={event => setDrafts(current => ({ ...current, [question.id]: event.target.value }))} />
          <button type="submit" className="secretaryButton primary" disabled={!drafts[question.id]?.trim() || Boolean(sending) || refreshing}>
            {sending === question.id ? <LoaderCircle className="spin" /> : <Send />} {sending === question.id ? "Сохраняю…" : "Отправить ответ"}
          </button>
        </form>
      </article>)}
      <details className="secretaryArchive">
        <summary>Отвеченные и снятые ({archived.length})</summary>
        <div className="secretaryArchiveList">
          {!archived.length ? <p className="secretaryContext">Пока нет отвеченных или снятых вопросов.</p> : null}
          {[...archived].reverse().map((question, index) => <article className="secretaryQuestion" key={`${question.id}-${index}`}>
            <div className="secretaryMeta"><strong>№{question.id} · {question.agent || "Агент"}</strong><span>{question.date}</span></div>
            <h3>{question.question}</h3>
            {question.answer ? <p className="secretaryAnswer"><strong>Твой ответ:</strong> {question.answer}</p> : null}
            {question.note ? <p className="secretaryContext">{question.note}</p> : null}
          </article>)}
        </div>
      </details>
    </> : null}
  </div>;
}
