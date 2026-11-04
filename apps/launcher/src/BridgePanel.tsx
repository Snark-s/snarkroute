import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { ownerHeaders } from "./AgentOpsPanel";

type Client = { id: string; accessLevel: number; level3ViaTunnel: boolean; scopes: number; roots: number };
type Pending = { digest: string; client: string; operation: string; summary: string; reason: string; channel?: string; at: string };
const LEVELS = ["0 · наблюдатель", "1 · работник", "2 · автономный оператор", "3 · доверенный представитель"];
const OPERATION: Record<string, string> = { process_start: "запуск программы", job_submit: "фоновая задача", start_managed_service: "запуск службы", yandex_mail_send: "отправка письма" };

async function call<T>(apiBase: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}/api/system/snarkbridge${path}`, {
    method, headers: { ...await ownerHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json() as T & { ok: boolean; error?: string };
  if (!response.ok || !data.ok) throw new Error(data.error || (response.status === 401 ? "Нужен вход владельца в Мастерской." : "Мост не ответил."));
  return data;
}

/** B3: what SnarkBridge refused without the owner, and the access level of each bridge client. */
export function BridgePanel({ apiBase, onPendingChange }: { apiBase: string; onPendingChange?: (pending: number) => void }) {
  const [clients, setClients] = useState<Client[]>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [policy, queue] = await Promise.all([call<{ clients: Client[] }>(apiBase, "/policy"), call<{ pending: Pending[] }>(apiBase, "/pending")]);
      if (mounted.current) { setClients(policy.clients); setPending(queue.pending); setError(""); onPendingChange?.(queue.pending.length); }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Не удалось прочитать мост."); }
  }, [apiBase, onPendingChange]);

  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);

  async function act(key: string, run: () => Promise<string>) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { const message = await run(); if (mounted.current) setNotice(message); await refresh(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Действие не выполнено."); }
    finally { if (mounted.current) setBusy(""); }
  }
  const decide = (item: Pending, decision: "approve" | "reject") => act(item.digest, async () => {
    await call(apiBase, `/pending/${item.digest}/${decision}`, "POST");
    return decision === "approve" ? `Разрешено один раз на 10 минут: ${item.client}, ${OPERATION[item.operation] ?? item.operation}. Агент повторит запрос сам.` : "Запрос отклонён.";
  });
  const setLevel = (client: Client, change: { accessLevel?: number; level3ViaTunnel?: boolean }) => act(`level-${client.id}`, async () => {
    await call(apiBase, `/policy/clients/${encodeURIComponent(client.id)}`, "POST", change);
    return `Уровень клиента ${client.id} изменён; мост подхватит его без перезапуска.`;
  });

  return <section className="secretaryWorkspace bridgePanel">
    <header className="secretaryHeader">
      <div><h2>Мост</h2><p>Что SnarkBridge не стал делать без тебя, и права его клиентов. Одобрение действует один раз и ровно на этот запрос.</p></div>
      <button type="button" className="secretaryButton" onClick={() => void refresh()} disabled={Boolean(busy)}><RefreshCw /> Обновить</button>
    </header>
    {error ? <div className="errorBanner" role="alert">{error}</div> : null}
    {notice ? <div className="successBanner" role="status">{notice}</div> : null}
    <p className="secretarySummary"><strong>{pending.length}</strong> ждут решения</p>
    {!pending.length ? <div className="secretaryEmpty"><CheckCircle2 /> Мост ничего не ждёт от тебя.</div> : null}
    {pending.map(item => <article className="secretaryQuestion" key={item.digest}>
      <div className="secretaryMeta"><strong>{item.client} · {OPERATION[item.operation] ?? item.operation}{item.channel === "tunnel" ? " · через туннель" : ""}</strong><span>{new Date(item.at).toLocaleString("ru-RU")}</span></div>
      <h3>{item.reason}</h3>
      <pre className="secretaryContext bridgeSummary">{item.summary}</pre>
      <div className="secretaryForm">
        <button type="button" className="secretaryButton primary" disabled={Boolean(busy)} onClick={() => void decide(item, "approve")}>
          {busy === item.digest ? <LoaderCircle className="spin" /> : <ShieldCheck />} Одобрить один раз
        </button>
        <button type="button" className="secretaryButton" disabled={Boolean(busy)} onClick={() => void decide(item, "reject")}><X /> Отказать</button>
      </div>
    </article>)}
    <details className="secretaryArchive">
      <summary>Уровни клиентов моста ({clients?.length ?? 0})</summary>
      <div className="secretaryArchiveList">
        {(clients ?? []).map(client => <article className="secretaryQuestion" key={client.id}>
          <div className="secretaryMeta"><strong>{client.id}</strong><span>{client.roots} корней · {client.scopes} прав</span></div>
          <label>Уровень{" "}
            <select value={client.accessLevel} disabled={Boolean(busy)} onChange={event => void setLevel(client, { accessLevel: Number(event.target.value) })}>
              {LEVELS.map((label, level) => <option key={level} value={level}>{label}</option>)}
            </select>
          </label>
          {client.accessLevel === 3 ? <label className="secretaryContext"><input type="checkbox" checked={client.level3ViaTunnel} disabled={Boolean(busy)}
            onChange={event => void setLevel(client, { level3ViaTunnel: event.target.checked })} /> уровень 3 и через туннель OpenAI (иначе через туннель — уровень 2)</label> : null}
        </article>)}
      </div>
    </details>
  </section>;
}
