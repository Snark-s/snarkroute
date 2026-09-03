import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Cpu, ExternalLink, Film, KeyRound, Link, LoaderCircle, Plug, RefreshCw, Server, Settings2, ShieldAlert, Unplug, X } from "lucide-react";
import { apiBase } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";
import { navigate } from "../../shared/navigation";
import { H3QueuePanel } from "./H3QueuePanel";
import "./H3Studio.css";

type CapabilityStatus = {
  name: string;
  available: boolean;
  experimental?: boolean;
  reason?: string | null;
};

type ConnectionStatus = {
  configured: boolean;
  connected: boolean;
  ready: boolean;
  workerUrl: string;
  backend?: string;
  backendVersion?: string;
  reason?: string | null;
  activeJobs?: number;
  capabilities: CapabilityStatus[];
  error?: string;
};

const EMPTY_STATUS: ConnectionStatus = {
  configured: false,
  connected: false,
  ready: false,
  workerUrl: "",
  capabilities: []
};

const VAST_H3_SEARCH_URL = "https://cloud.vast.ai/create/?gpuRamMin=49152&instanceDiskSizeMin=300&machinePortsOpenMin=2&machineReliabilityMin=0.985&offerGpuNumMax=1&offerGpuNumMin=1&versionCudaMin=13.2&machineCpuRamMin=262144";

const vastH3Filters = [
  "1× GPU",
  "VRAM ≥ 48 GB",
  "RAM ≥ 256 GB",
  "Диск ≥ 300 GB",
  "Reliability ≥ 98,5%",
  "Max CUDA ≥ 13.0",
  "Порты ≥ 2"
] as const;

const tools = [
  { id: "text", title: "Текст → видео и звук", description: "Создание ролика по описанию.", capability: "fl2va", badge: "проверено на GPU" },
  { id: "frames", title: "Первый / последний кадр", description: "Оживить кадр или построить переход между двумя кадрами.", capability: "fl2va", badge: "нужна GPU-проверка" },
  { id: "motion", title: "Движение из видео", description: "Ref2VA использует действие, камеру и ритм исходного видео как смысловой референс.", capability: "ref2va", badge: "эксперимент" },
  { id: "references", title: "Персонаж, стиль и звук", description: "Изображения, видео и аудио как совместные референсы.", capability: "ref2va", badge: "эксперимент" },
  { id: "replace", title: "Замена области или объекта", description: "Маска, стабильный crop и masked sampling.", capability: "video_inpaint", badge: "лаборатория" },
  { id: "tracking", title: "Автотрекинг объекта", description: "Автоматическое распространение выделения по кадрам.", capability: "automatic_tracking", badge: "ещё не подключено" },
  { id: "resample", title: "Перегенерация 2K", description: "Отдельный hosted H3 Regenerate этап.", capability: "resample", badge: "отдельный сервис" }
] as const;

export function H3Studio() {
  const [status, setStatus] = useState<ConnectionStatus>(EMPTY_STATUS);
  const [workerUrl, setWorkerUrl] = useState("");
  const [serviceToken, setServiceToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    const previousTitle = document.title;
    const favicon = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    const previousFaviconHref = favicon?.getAttribute("href") ?? null;
    const previousFaviconType = favicon?.getAttribute("type") ?? null;
    document.title = "H3 Studio · SnarkRoute";
    if (favicon) {
      favicon.href = "/h3-studio-icon.svg";
      favicon.type = "image/svg+xml";
    }
    void refresh(false);
    return () => {
      document.title = previousTitle;
      if (!favicon) return;
      if (previousFaviconHref === null) favicon.removeAttribute("href");
      else favicon.setAttribute("href", previousFaviconHref);
      if (previousFaviconType === null) favicon.removeAttribute("type");
      else favicon.setAttribute("type", previousFaviconType);
    };
  }, []);

  const capabilityMap = useMemo(() => new Map(status.capabilities.map((item) => [item.name, item])), [status.capabilities]);

  async function refresh(announce = true) {
    setLoading(true);
    try {
      const response = await apiFetch(`${apiBase}/api/h3/connection`);
      const result = await response.json() as ConnectionStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось проверить H3 worker.");
      setStatus(result);
      setWorkerUrl((current) => result.workerUrl || current);
      if (announce) setMessage(result.ready ? "Сохранённое подключение H3 работает." : result.error ?? result.reason ?? "H3 worker пока не готов.");
      else setMessage("");
    } catch (error) {
      setStatus(EMPTY_STATUS);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function activateH3() {
    if (!status.configured) {
      setAdvancedOpen(true);
      setMessage("Для первого подключения нужен адрес уже развёрнутого worker и созданный при его запуске H3_WORKER_SERVICE_TOKEN. После успешной проверки SnarkRoute сохранит их сам.");
      return;
    }
    await refresh(true);
  }

  async function connect() {
    if (!workerUrl.trim() || !serviceToken.trim()) {
      setMessage("Укажи адрес H3 worker и сервисный токен.");
      return;
    }
    setBusy(true);
    setMessage("Проверяю worker, авторизацию и CUDA backend…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerUrl, serviceToken })
      });
      const result = await response.json() as { status?: ConnectionStatus; error?: string };
      if (!response.ok || !result.status) throw new Error(result.error ?? "H3 worker не готов.");
      setStatus(result.status);
      setWorkerUrl(result.status.workerUrl);
      setServiceToken("");
      setAdvancedOpen(false);
      setMessage("H3 подключён. Токен сохранён только на локальном сервере SnarkRoute.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function forgetConnection() {
    const confirmed = window.confirm("Удалить адрес и токен H3 из локальных настроек? Это НЕ остановит и НЕ удалит арендованный GPU-сервер.");
    if (!confirmed) return;
    setBusy(true);
    try {
      const response = await apiFetch(`${apiBase}/api/h3/connection`, { method: "DELETE" });
      const result = await response.json() as { status?: ConnectionStatus; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось удалить подключение.");
      setStatus(result.status ?? EMPTY_STATUS);
      setWorkerUrl("");
      setServiceToken("");
      setMessage("Подключение забыто. Состояние и тарификацию удалённого сервера нужно проверить отдельно.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="h3Studio">
      <header className="h3StudioHeader">
        <div className="h3StudioBrand">
          <span className="h3StudioMark"><img src="/h3-studio-icon.svg" alt="" /></span>
          <div>
            <strong>H3 Studio</strong>
            <span>MiniMax H3 внутри SnarkRoute</span>
          </div>
        </div>
        <div className="h3StudioHeaderActions">
          <button type="button" onClick={() => navigate("/")}><ArrowLeft size={16} /> Boojum canvas</button>
          <button type="button" onClick={() => window.close()}><X size={16} /> Закрыть</button>
        </div>
      </header>

      <section className="h3StudioHero">
        <div>
          <span className="h3Eyebrow">AUDIO · VIDEO · REFERENCES</span>
          <h1>Рабочее место для H3, а не ещё один граф.</h1>
          <p>Подключи GPU-worker, выбери задачу и работай с кадрами, видео, звуком и масками. Любую операцию позже можно раскрыть как переносимый маршрут SnarkRoute.</p>
        </div>
        <ConnectionBadge status={status} loading={loading} />
      </section>

      <div className="h3StudioGrid">
        <section className="h3ConnectionPanel">
          <header>
            <div>
              <span className="h3PanelIcon"><Plug size={18} /></span>
              <div><h2>Подключение H3</h2><p>Сохранённые настройки проверяются автоматически при открытии Studio.</p></div>
            </div>
            <button className="h3IconButton" type="button" onClick={() => void refresh(true)} disabled={loading || busy} title="Проверить снова"><RefreshCw size={16} /></button>
          </header>

          <div className={`h3SavedConnection ${status.ready ? "ready" : ""}`}>
            <span className="h3SavedConnectionIcon">{status.ready ? <Check size={19} /> : <KeyRound size={19} />}</span>
            <div>
              <strong>{status.ready ? "H3 подключён" : status.configured ? "Подключение сохранено" : "H3 ещё не настроен"}</strong>
              <span>{status.configured ? `${status.workerUrl} · сервисный токен сохранён на локальном сервере` : "Первичная настройка выполняется один раз"}</span>
            </div>
          </div>

          <div className="h3ConnectionActions">
            <button className="h3Primary" type="button" onClick={() => void activateH3()} disabled={busy || loading}>
              {busy || loading ? <LoaderCircle className="h3Spin" size={16} /> : status.configured ? <RefreshCw size={16} /> : <Plug size={16} />}
              {status.ready ? "Проверить H3" : status.configured ? "Подключить сохранённый H3" : "Запустить / подключить H3"}
            </button>
          </div>

          {!status.configured ? (
            <div className="h3VastRental">
              <div className="h3VastRentalHeading">
                <span className="h3VastRentalIcon"><Server size={18} /></span>
                <div>
                  <strong>Нужен GPU-worker?</strong>
                  <span>Открой Vast.ai с готовым профилем ресурсов для первого запуска H3.</span>
                </div>
              </div>
              <div className="h3VastFilters" aria-label="Фильтры аренды Vast.ai">
                {vastH3Filters.map((filter) => <span key={filter}>{filter}</span>)}
              </div>
              <p>После открытия выбери именно <strong>RTX 4090</strong> и разрешённую страну: не США, ЕС, Великобритания или Южная Корея. Эти два пункта Vast не сохраняет в нашей проверенной ссылке поиска.</p>
              <a className="h3VastButton" href={VAST_H3_SEARCH_URL} target="_blank" rel="noreferrer">
                Открыть Vast.ai с фильтрами <ExternalLink size={15} />
              </a>
            </div>
          ) : null}
          {message ? <p className={status.ready ? "h3Message" : "h3Message warning"}>{message}</p> : null}

          <button className={`h3AdvancedToggle ${advancedOpen ? "open" : ""}`} type="button" onClick={() => setAdvancedOpen((value) => !value)}>
            <Settings2 size={15} /> Ручное подключение <ChevronDown size={15} />
          </button>

          {advancedOpen ? (
            <div className="h3ManualConnection">
              <div className="h3ConnectionHelp">
                <p><strong>Адрес worker</strong> появляется после развёртывания H3 на GPU: внешний HTTPS endpoint либо локальный адрес SSH-туннеля.</p>
                <p><strong>Service token</strong> — значение <code>H3_WORKER_SERVICE_TOKEN</code>, созданное при запуске worker.</p>
                <p>После первой успешной проверки SnarkRoute сохранит оба значения на локальном сервере. Повторно вводить их не потребуется.</p>
              </div>
              <label>
                <span>Адрес worker</span>
                <input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="https://gpu.example:8000" autoComplete="url" />
              </label>
              <label>
                <span>H3 service token</span>
                <input type="password" value={serviceToken} onChange={(event) => setServiceToken(event.target.value)} placeholder={status.configured ? "Введи новый токен только для замены" : "Вставь токен worker"} autoComplete="off" />
              </label>
              <div className="h3ConnectionActions">
                <button type="button" onClick={() => void connect()} disabled={busy}>
                  {busy ? <LoaderCircle className="h3Spin" size={16} /> : <Link size={16} />} Проверить и сохранить
                </button>
                {status.configured ? <button type="button" onClick={() => void forgetConnection()} disabled={busy}><Unplug size={16} /> Забыть подключение</button> : null}
              </div>
            </div>
          ) : null}

          <p className="h3BillingWarning"><ShieldAlert size={16} /> Закрытие H3 Studio или удаление токена не останавливает аренду. Остановку и уничтожение GPU нужно подтверждать отдельно.</p>

          {status.configured ? (
            <div className="h3RuntimeDetails">
              <span>Worker</span><strong>{status.workerUrl}</strong>
              <span>Backend</span><strong>{status.backend ? `${status.backend}${status.backendVersion ? ` · ${status.backendVersion}` : ""}` : "не определён"}</strong>
              <span>Активные задачи</span><strong>{status.activeJobs ?? "—"}</strong>
              <span>Сообщение worker</span><strong>{status.error ?? status.reason ?? "готов"}</strong>
            </div>
          ) : null}
        </section>

        <section className="h3WorkspacePreview">
          <div className="h3StagePlaceholder">
            <Film size={42} />
            <strong>Предпросмотр и таймлайн</strong>
            <span>{status.ready ? "Worker готов. Следующий этап — загрузка исходников и запуск задач." : "Сначала подключи готовый H3 worker."}</span>
          </div>
          <div className="h3TimelineStub"><span /><span /><span /><span /><span /></div>
        </section>
      </div>

      <H3QueuePanel />

      <section className="h3ToolsSection">
        <header><div><h2>Возможности</h2><p>Карточка активна только когда worker честно объявил соответствующую capability.</p></div><Cpu size={20} /></header>
        <div className="h3ToolGrid">
          {tools.map((tool) => {
            const capability = capabilityMap.get(tool.capability);
            const available = status.ready && capability?.available === true;
            return (
              <article className={`h3ToolCard ${available ? "available" : ""}`} key={tool.id}>
                <div className="h3ToolCardStatus">{available ? <Check size={15} /> : <span>×</span>} {available ? "доступно" : capability?.reason ?? "недоступно"}</div>
                <h3>{tool.title}</h3>
                <p>{tool.description}</p>
                <footer><span>{tool.badge}</span><code>{tool.capability}</code></footer>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function ConnectionBadge({ status, loading }: { status: ConnectionStatus; loading: boolean }) {
  if (loading) return <div className="h3ConnectionBadge"><LoaderCircle className="h3Spin" size={18} /><div><strong>Проверка</strong><span>читаю состояние worker</span></div></div>;
  if (status.ready) return <div className="h3ConnectionBadge ready"><Check size={18} /><div><strong>H3 готов</strong><span>{status.backend ?? "worker подключён"}</span></div></div>;
  return <div className="h3ConnectionBadge"><Unplug size={18} /><div><strong>Не подключён</strong><span>{status.error ?? status.reason ?? "нужен GPU-worker"}</span></div></div>;
}
