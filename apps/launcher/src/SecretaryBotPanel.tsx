import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, Send, X } from "lucide-react";
import { ownerHeaders } from "./AgentOpsPanel";

type BotStatus = { configured: boolean; botName?: string | null; paired?: boolean; pairingCode?: string | null; minIntervalMinutes?: number; queued?: number; error?: string | null };

async function call(apiBase: string, method = "GET", body?: unknown): Promise<BotStatus> {
  const response = await fetch(`${apiBase}/api/agent-ops/secretary/telegram`, {
    method, headers: { ...await ownerHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json() as { ok?: boolean; telegram?: BotStatus; error?: string };
  if (!response.ok || !data.telegram) throw new Error(data.error || (response.status === 401 ? "Нужен вход владельца в Мастерской." : "SnarkRoute не ответил."));
  return data.telegram;
}

/** D2: connect the Secretary's own Telegram bot; the token goes in once and is never shown again. */
export function SecretaryBotPanel({ apiBase }: { apiBase: string }) {
  const [status, setStatus] = useState<BotStatus>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setStatus(await call(apiBase)); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }, [apiBase]);
  useEffect(() => {
    void load();
    // While pairing, check often so the panel flips to «подключён» right after the code is sent.
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, status?.configured && !status.paired ? 4000 : 60_000);
    return () => window.clearInterval(timer);
  }, [load, status?.configured, status?.paired]);
  async function run(body: unknown) {
    setBusy(true); setError("");
    try { setStatus(await call(apiBase, "POST", body)); setToken(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <details className="secretaryArchive" open={!status?.paired}>
    <summary>Бот Секретаря в Telegram {status?.paired ? `· @${status.botName} подключён` : status?.configured ? "· ждёт код" : "· не подключён"}</summary>
    <div className="secretaryArchiveList">
      {error ? <div className="errorBanner" role="alert">{error}</div> : null}
      {status?.error ? <div className="errorBanner" role="alert">Telegram: {status.error}</div> : null}
      {!status?.configured ? <>
        <ol className="secretaryContext botSteps">
          <li>В Telegram открой <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> и отправь <code>/newbot</code>.</li>
          <li>Имя — например «Секретарь Мастерской», адрес — любой свободный, оканчивающийся на <code>bot</code>.</li>
          <li>BotFather пришлёт токен вида <code>123456789:AA…</code>. Вставь его сюда — он сохранится в Мастерской и больше нигде не покажется.</li>
        </ol>
        <form className="secretaryForm bridgeSecretForm" autoComplete="off" onSubmit={event => { event.preventDefault(); void run({ token }); }}>
          <input type="password" autoComplete="off" placeholder="токен бота от BotFather" value={token} onChange={event => setToken(event.target.value)} disabled={busy} />
          <button type="submit" className="secretaryButton primary" disabled={busy || !token.trim()}>{busy ? <LoaderCircle className="spin" /> : <Send />} Подключить</button>
        </form>
      </> : !status.paired ? <p className="secretaryContext">Открой <a href={`https://t.me/${status.botName}?start=${status.pairingCode}`} target="_blank" rel="noreferrer">@{status.botName}</a> и нажми «Start» (или отправь ему <code>/start {status.pairingCode}</code>). Бот запомнит твой чат и будет слушать только его.</p>
      : <div className="secretaryForm">
        <span className="secretaryContext"><CheckCircle2 /> Пиши боту цели. Сообщения от Секретаря склеиваются и приходят не чаще, чем раз в</span>
        <select value={status.minIntervalMinutes ?? 15} disabled={busy} onChange={event => void run({ minIntervalMinutes: Number(event.target.value) })}>
          {[5, 15, 30, 60, 180, 720].map(minutes => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} мин` : `${minutes / 60} ч`}</option>)}
        </select>
        <button type="button" className="secretaryButton" disabled={busy} onClick={() => void run({ disconnect: true })}><X /> Отключить</button>
      </div>}
    </div>
  </details>;
}
