import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, Smartphone, X } from "lucide-react";
import { ownerHeaders } from "./AgentOpsPanel";

type SmsStatus = { configured: boolean; url?: string; username?: string; savedAt?: string; lastOkAt?: string; lastError?: string | null; lastCount?: number };
type Reply = { ok?: boolean; sms?: SmsStatus; sample?: Array<{ sender: string; receivedAt: string }>; error?: string };

async function call(apiBase: string, method = "GET", body?: unknown): Promise<Reply> {
  const response = await fetch(`${apiBase}/api/agent-ops/sms`, {
    method, headers: { ...await ownerHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000)
  });
  const data = await response.json() as Reply;
  if (!response.ok || !data.sms) throw new Error(data.error || (response.status === 401 ? "Нужен вход владельца в Мастерской." : "SnarkRoute не ответил."));
  return data;
}

/** The phone with «SMS Gateway for Android» as Buzha's read-only SMS inbox. Login and password go in once. */
export function SmsGatewayPanel({ apiBase }: { apiBase: string }) {
  const [status, setStatus] = useState<SmsStatus>();
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { setStatus((await call(apiBase)).sms); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }, [apiBase]);
  useEffect(() => { void load(); }, [load]);
  async function run(body: unknown, done: (reply: Reply) => string) {
    setBusy(true); setError(""); setNotice("");
    try { const reply = await call(apiBase, "POST", body); setStatus(reply.sms); setPassword(""); setNotice(done(reply)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <details className="secretaryArchive" open={!status?.configured}>
    <summary><Smartphone /> SMS телефона Бужи {status?.configured ? `· подключён (${status.url})` : "· не подключён"}</summary>
    <div className="secretaryArchiveList">
      {error ? <div className="errorBanner" role="alert">{error}</div> : null}
      {notice ? <div className="successBanner" role="status">{notice}</div> : null}
      {status?.lastError ? <div className="errorBanner" role="alert">Телефон: {status.lastError}</div> : null}
      {!status?.configured ? <>
        <ol className="secretaryContext botSteps">
          <li>На телефоне в приложении SMS Gateway включи <strong>«Локальный сервер»</strong> (Local Server) и нажми «Офлайн» → «Онлайн», чтобы он запустился.</li>
          <li>Телефон и компьютер должны быть в одной сети Wi-Fi.</li>
          <li>На вкладке «Главная» приложения есть адрес (например <code>192.168.1.23:8080</code>), логин и пароль — перепиши их сюда. Пароль сохранится зашифрованным и больше нигде не покажется. Бужа сможет только <em>читать</em> входящие SMS, отправлять — нет.</li>
        </ol>
        <form className="secretaryForm bridgeSecretForm" autoComplete="off" onSubmit={event => { event.preventDefault(); void run({ url, username, password }, () => "Телефон ответил — SMS подключены."); }}>
          <input placeholder="адрес: 192.168.1.23:8080" value={url} onChange={event => setUrl(event.target.value)} disabled={busy} />
          <input placeholder="логин из приложения" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} disabled={busy} />
          <input type="password" placeholder="пароль из приложения" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
          <button type="submit" className="secretaryButton primary" disabled={busy || !url.trim() || !username.trim() || !password}>{busy ? <LoaderCircle className="spin" /> : <CheckCircle2 />} Проверить и сохранить</button>
        </form>
      </> : <div className="secretaryForm">
        <span className="secretaryContext"><CheckCircle2 /> Логин {status.username}{status.lastOkAt ? ` · последний ответ ${new Date(status.lastOkAt).toLocaleString("ru-RU")}` : ""}</span>
        <button type="button" className="secretaryButton" disabled={busy} onClick={() => void run({ test: true }, reply => reply.sample?.length ? `Телефон отвечает. Последние SMS: ${reply.sample.map(item => `${item.sender} (${new Date(item.receivedAt).toLocaleString("ru-RU")})`).join(", ")}` : "Телефон отвечает, входящих SMS пока нет.")}>{busy ? <LoaderCircle className="spin" /> : null} Проверить</button>
        <button type="button" className="secretaryButton" disabled={busy} onClick={() => void run({ disconnect: true }, () => "SMS отключены, пароль удалён.")}><X /> Отключить</button>
      </div>}
    </div>
  </details>;
}
