import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, Plus, Send, Square } from "lucide-react";
import { ownerHeaders } from "./AgentOpsPanel";

type Question = { id: string; agentId: string; title: string; goal: string; reason: string; ownerReason: string; nextStep: string; updatedAt: string; rootTaskId: string; budget: boolean;
  usage?: { subscriptionRunsUsed: number; limits: { subscriptionRuns: number } } };

const AGENT: Record<string, string> = { "app:buzha": "Бужа", "app:secretary": "Секретарь", "app:tove": "Шорёк", "app:factory": "Фабрика", owner: "ты" };
const agentName = (id: string) => AGENT[id] ?? (id.startsWith("task:") ? `подзадача ${id.slice(5)}` : id);

async function call<T>(apiBase: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}/api/agent-ops/owner-questions${path}`, {
    method: body ? "POST" : "GET", headers: { ...await ownerHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || (response.status === 401 ? "Нужен вход владельца в Мастерской." : "SnarkRoute не ответил."));
  return data;
}

/** Questions the agent queue put to the owner: each one answered here, in one place (the Secretary tab). */
export function OwnerQuestionsPanel({ apiBase, onPendingChange }: { apiBase: string; onPendingChange?: (count: number) => void }) {
  const [questions, setQuestions] = useState<Question[]>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try { const data = await call<{ questions: Question[] }>(apiBase, ""); setQuestions(data.questions); onPendingChange?.(data.questions.length); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [apiBase, onPendingChange]);
  useEffect(() => { void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000); return () => window.clearInterval(timer); }, [load]);
  async function act(question: Question, action: "extend" | "answer" | "stop") {
    setBusy(`${question.id}:${action}`); setError(""); setNotice("");
    try {
      await call(apiBase, `/${question.id}`, { action, note: answers[question.id] ?? "" });
      setNotice(action === "stop" ? "Задача остановлена." : action === "extend" ? "Бюджет продлён — задача продолжает работу." : "Ответ передан — задача продолжает работу.");
      setAnswers(current => { const next = { ...current }; delete next[question.id]; return next; });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  }
  if (!questions?.length && !error) return null;
  return <section className="secretaryWorkspace ownerQuestions">
    <header className="secretaryHeader"><div><h2>Вопросы агентов</h2><p>Задачи очереди, которые остановились и ждут именно твоего решения.</p></div></header>
    {error ? <div className="errorBanner" role="alert">{error}</div> : null}
    {notice ? <div className="successBanner" role="status">{notice}</div> : null}
    {(questions ?? []).map(question => <article key={question.id} className="secretaryQuestion">
      <div className="secretaryMeta"><strong>{question.title}</strong><span>{agentName(question.agentId)} · {question.id} · {new Date(question.updatedAt).toLocaleString("ru-RU")}</span></div>
      <p className="secretaryContext"><b>Что нужно:</b> {question.budget
        ? `закончился запас запусков по подписке (${question.usage?.subscriptionRunsUsed ?? "?"} из ${question.usage?.limits.subscriptionRuns ?? "?"}). Это не деньги — квота подписки. «Продлить» поднимет запас до твоего потолка и продолжит работу.`
        : question.reason}</p>
      <details><summary>Подробности задачи</summary><p className="secretaryContext">{question.goal}</p>{question.nextStep ? <p className="secretaryContext">Следующий шаг: {question.nextStep}</p> : null}</details>
      <form className="secretaryForm" onSubmit={event => { event.preventDefault(); void act(question, "answer"); }}>
        <input placeholder={question.budget ? "комментарий (необязательно)" : "твой ответ агенту"} value={answers[question.id] ?? ""} maxLength={4000} disabled={Boolean(busy)} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />
        {question.budget ? <button type="button" className="secretaryButton primary" disabled={Boolean(busy)} onClick={() => void act(question, "extend")}>{busy === `${question.id}:extend` ? <LoaderCircle className="spin" /> : <Plus />} Продлить</button> : null}
        <button type="submit" className={`secretaryButton${question.budget ? "" : " primary"}`} disabled={Boolean(busy) || !(answers[question.id] ?? "").trim()}>{busy === `${question.id}:answer` ? <LoaderCircle className="spin" /> : <Send />} Ответить</button>
        <button type="button" className="secretaryButton" disabled={Boolean(busy)} onClick={() => void act(question, "stop")}>{busy === `${question.id}:stop` ? <LoaderCircle className="spin" /> : <Square />} Остановить</button>
      </form>
    </article>)}
    {questions && !questions.length ? <div className="secretaryEmpty"><CheckCircle2 /> Вопросов нет.</div> : null}
  </section>;
}
