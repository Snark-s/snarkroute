import { ArrowUpRight, CheckCircle2, Circle, LoaderCircle, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { changeProjectPublisher, readProjectPublisherStatus, type ProjectPublisherStatus } from "./projectPublisherClient";

function useProjectPublisher() {
  const base = `http://127.0.0.1:${import.meta.env.VITE_LAUNCHER_CONTROL_PORT || 5176}`;
  const [status, setStatus] = useState<ProjectPublisherStatus>();
  const [action, setAction] = useState<"start" | "stop" | "">("");
  const [error, setError] = useState("");

  async function refresh() {
    const next = await readProjectPublisherStatus(base);
    setStatus(next);
    setError(next.operation?.state === "error" ? next.operation.error || "Ошибка Project Publisher" : "");
  }

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await readProjectPublisherStatus(base);
        if (!disposed) {
          setStatus(next);
          setError(next.operation?.state === "error" ? next.operation.error || "Ошибка Project Publisher" : "");
        }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Управление Project Publisher недоступно");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [base]);

  async function change(nextAction: "start" | "stop") {
    setAction(nextAction);
    setError("");
    try {
      const next = await changeProjectPublisher(base, nextAction);
      setStatus(next);
      await refresh();
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить состояние Project Publisher");
      await refresh().catch(() => undefined);
    } finally {
      setAction("");
    }
  }

  return { status, action, error, change };
}

export function ProjectPublisherControl({ logAlert = false }: { logAlert?: boolean }) {
  const { status, action, error, change } = useProjectPublisher();

  const running = Boolean(status?.running);
  const external = Boolean(status?.external);
  const working = Boolean(action) || Boolean(status?.operation && ["starting", "stopping"].includes(status.operation.state));
  const label = external
    ? "занят вне Мастерской"
    : running
      ? status?.healthy ? "работает" : "запущен"
      : "остановлен";
  const canChange = Boolean(status?.available) && !external && !working;
  const nextAction = running ? "stop" : "start";

  return <span className={`runtimeMini publisherMini ${running ? "ready" : "stopped"} ${external ? "error" : ""}`} title={`${error || `Project Publisher: ${label}`} · правый клик: терминал`} data-service-id="publisher" data-service-label="Publisher" data-log-alert={logAlert || undefined}>
    <span className="runtimeMiniDot" />
    <span>Publisher</span>
    <button type="button" aria-label={`${nextAction === "stop" ? "Остановить" : "Запустить"} Project Publisher`} title={`${nextAction === "stop" ? "Остановить" : "Запустить"} Project Publisher`} disabled={!canChange} onClick={() => void change(nextAction)}>
      {working ? <LoaderCircle className="spin" /> : nextAction === "stop" ? <Square /> : <Play />}
    </button>
  </span>;
}

export function ProjectPublisherCard() {
  const { status, action, error, change } = useProjectPublisher();

  async function open() {
    const popup = window.open("about:blank", "project-publisher");
    try {
      let next = status;
      if (!next?.running) next = await change("start");
      const url = next?.url || "http://127.0.0.1:8765";
      if (popup) popup.location.href = url; else location.href = url;
    } catch {
      popup?.close();
    }
  }

  const running = Boolean(status?.running);
  const busy = Boolean(action);
  return <div className="appCard violet" style={{ animationDelay: "330ms" }}>
    <button className="cardMain" onClick={() => void open()} disabled={busy || status?.external || status?.available === false} title={error || "Открыть Project Publisher"}>
      <span className="cardGlow" />
      <span className="appIcon branded"><img src="/project-publisher-icon.png" alt="" /></span>
      <span className="appCopy"><strong>Project Publisher</strong><small>Подготовка и публикация проектов</small></span>
      <span className="cardFooter">
        <span className={running ? "status on" : "status"}>{running ? <CheckCircle2 /> : <Circle />}{running ? "открыто" : busy ? "запускается" : "готово"}</span>
        {busy ? <LoaderCircle className="spin" /> : <ArrowUpRight />}
      </span>
    </button>
  </div>;
}
