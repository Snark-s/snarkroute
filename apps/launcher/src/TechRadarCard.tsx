import { ArrowUpRight, CheckCircle2, Circle, LoaderCircle } from "lucide-react";

/** Tech Radar shares the Living Canvas service and its launcher lifecycle. */
export function TechRadarCard({ running, busy, index, onOpen }: {
  running: boolean;
  busy: boolean;
  index: number;
  onOpen: () => void;
}) {
  return <div className="appCard cyan" style={{ animationDelay: `${index * 55}ms` }}>
    <button className="cardMain" onClick={onOpen} disabled={busy} title="Открыть Технорадар">
      <span className="cardGlow" />
      <span className="appIcon branded"><img src="/tech-radar-icon.svg" alt="" /></span>
      <span className="appCopy"><strong>Технорадар</strong><small>Проекты, исследования и решения для SnarkRoute</small></span>
      <span className="cardFooter">
        <span className={running ? "status on" : "status"}>{running ? <CheckCircle2 /> : <Circle />}{busy ? "запускается" : running ? "доступен" : "готово"}</span>
        {busy ? <LoaderCircle className="spin" /> : <ArrowUpRight />}
      </span>
    </button>
  </div>;
}
