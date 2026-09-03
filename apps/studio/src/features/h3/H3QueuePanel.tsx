import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Cloud, CopyPlus, Dices, Download, ListPlus, LoaderCircle, Pencil, Play, Settings2, Trash2, Upload, X } from "lucide-react";
import { apiBase } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";

type Operation = "text_to_video" | "first_last_frame" | "motion_transfer" | "reference_mix" | "replace_object" | "automatic_tracking" | "regenerate_2k";
type ItemStatus = "ready" | "running" | "succeeded" | "failed" | "blocked";
type SessionStatus = "idle" | "connecting" | "rendering" | "cleaning" | "completed" | "completed_with_errors" | "failed" | "cleanup_failed";
type AssetSlot = "firstFrame" | "lastFrame" | "referenceImage" | "referenceVideo" | "referenceAudio" | "sourceVideo" | "mask";
type AssetKind = "image" | "video" | "audio";

type QueueAsset = { slot: AssetSlot; kind: AssetKind; path: string; filename: string; mimeType: string };
type QueueItem = {
  id: string;
  title: string;
  operation: Operation;
  prompt: string;
  duration: number;
  aspectRatio: string;
  seed?: number;
  variants: number;
  renderMode: "preview" | "final";
  promptJson?: Record<string, unknown>;
  assets: QueueAsset[];
  status: ItemStatus;
  progress: number;
  stage?: string;
  resultPaths?: string[];
  error?: string;
};
type QueueSession = {
  id: string;
  mode: "saved_worker" | "vast";
  status: SessionStatus;
  currentItemId?: string;
  managedInstanceId?: number;
  hourlyPriceUsd?: number;
  cleanupConfirmed: boolean | null;
  error?: string;
};
type VastStatus = {
  configured: boolean;
  apiKeyConfigured: boolean;
  templateHashConfigured: boolean;
  workerUrlTemplateConfigured: boolean;
  sshKeyConfigured: boolean;
  hfTokenConfigured: boolean;
  serviceTokenConfigured: boolean;
  licenseAccepted: boolean;
  connectionMode: "ssh_tunnel" | "external_https";
  maxHourlyUsd: number;
  excludedCountryCodes: string[];
  workerUrlTemplate: string;
  sshPrivateKeyPath: string;
  sourceRevision: string;
  image: string;
  reason?: string;
};
type QueueState = { version: 1; items: QueueItem[]; session: QueueSession; vast: VastStatus };

const operations: Array<{ value: Operation; label: string; note: string; executable: boolean }> = [
  { value: "text_to_video", label: "Текст → видео и звук", note: "FL2VA без исходников", executable: true },
  { value: "first_last_frame", label: "Первый / последний кадр", note: "Один или два кадра", executable: true },
  { value: "motion_transfer", label: "Перенос движения", note: "Видео движения + необязательный первый кадр", executable: true },
  { value: "reference_mix", label: "Персонаж, стиль и звук", note: "Изображение, видео или аудио", executable: true },
  { value: "replace_object", label: "Замена области / объекта", note: "Ждёт video_inpaint backend", executable: false },
  { value: "automatic_tracking", label: "Автотрекинг объекта", note: "Ждёт tracking adapter", executable: false },
  { value: "regenerate_2k", label: "Перегенерация 2K", note: "Ждёт hosted Regenerate", executable: false }
];

const assetSlots: Record<Operation, Array<{ slot: AssetSlot; kind: AssetKind; label: string }>> = {
  text_to_video: [],
  first_last_frame: [
    { slot: "firstFrame", kind: "image", label: "Первый кадр" },
    { slot: "lastFrame", kind: "image", label: "Последний кадр" }
  ],
  motion_transfer: [
    { slot: "referenceVideo", kind: "video", label: "Видео движения" },
    { slot: "referenceImage", kind: "image", label: "Первый кадр / образ (необязательно)" }
  ],
  reference_mix: [
    { slot: "referenceImage", kind: "image", label: "Изображение" },
    { slot: "referenceVideo", kind: "video", label: "Видео" },
    { slot: "referenceAudio", kind: "audio", label: "Аудио" }
  ],
  replace_object: [
    { slot: "sourceVideo", kind: "video", label: "Исходное видео" },
    { slot: "mask", kind: "image", label: "Маска" },
    { slot: "referenceImage", kind: "image", label: "Новый объект" }
  ],
  automatic_tracking: [
    { slot: "sourceVideo", kind: "video", label: "Исходное видео" },
    { slot: "mask", kind: "image", label: "Выделение на кадре" }
  ],
  regenerate_2k: [{ slot: "sourceVideo", kind: "video", label: "Видео для 2K" }]
};

const EMPTY_VAST: VastStatus = {
  configured: false, apiKeyConfigured: false, templateHashConfigured: false, workerUrlTemplateConfigured: false,
  sshKeyConfigured: false, hfTokenConfigured: false, serviceTokenConfigured: false, licenseAccepted: false,
  connectionMode: "ssh_tunnel", maxHourlyUsd: 1.2, excludedCountryCodes: [], workerUrlTemplate: "", sshPrivateKeyPath: "", sourceRevision: "", image: ""
};

export function H3QueuePanel() {
  const [state, setState] = useState<QueueState | null>(null);
  const [operation, setOperation] = useState<Operation>("text_to_video");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptJson, setPromptJson] = useState("");
  const [duration, setDuration] = useState(5);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [variants, setVariants] = useState(1);
  const [seed, setSeed] = useState("");
  const [renderMode, setRenderMode] = useState<"preview" | "final">("final");
  const [assets, setAssets] = useState<QueueAsset[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragSlot, setDragSlot] = useState<AssetSlot | null>(null);
  const pasteTarget = useRef<{ slot: AssetSlot; kind: AssetKind } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [vastOpen, setVastOpen] = useState(false);
  const [vastForm, setVastForm] = useState({ apiKey: "", hfToken: "", sshPrivateKeyPath: "", maxHourlyUsd: "1.2", acceptLicense: false });

  const sessionActive = Boolean(state && ["connecting", "rendering", "cleaning"].includes(state.session.status));
  const operationInfo = useMemo(() => operations.find((item) => item.value === operation)!, [operation]);

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!sessionActive) return;
    const timer = window.setInterval(() => void refresh(false), 2_000);
    return () => window.clearInterval(timer);
  }, [sessionActive]);
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = pasteTarget.current;
      if (!target || busy || !event.clipboardData || !clipboardFiles(event.clipboardData).length) return;
      event.preventDefault();
      event.stopPropagation();
      pasteAsset(event.clipboardData, target.slot, target.kind);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [busy, operation]);

  async function refresh(showError = true) {
    try {
      const response = await apiFetch(`${apiBase}/api/h3/queue`);
      const result = await response.json() as QueueState & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось прочитать очередь H3.");
      setState(result);
      setVastForm((current) => ({
        ...current,
        maxHourlyUsd: String(result.vast?.maxHourlyUsd ?? 1.2),
        sshPrivateKeyPath: current.sshPrivateKeyPath || result.vast?.sshPrivateKeyPath || "",
        acceptLicense: current.acceptLicense || result.vast?.licenseAccepted === true
      }));
    } catch (error) {
      if (showError) setMessage(errorText(error));
    }
  }

  async function submitItem() {
    setBusy(true);
    setMessage("");
    try {
      const parsedJson = promptJson.trim() ? JSON.parse(promptJson) : undefined;
      const response = await apiFetch(`${apiBase}/api/h3/queue${editingId ? `/${editingId}` : ""}`, {
        method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() || operationInfo.label, operation, prompt, promptJson: parsedJson ?? null, duration, aspectRatio, variants, renderMode, assets, ...(seed.trim() ? { seed: Number(seed) } : {}) })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? (editingId ? "Не удалось сохранить изменения." : "Не удалось добавить задачу."));
      const wasEditing = Boolean(editingId);
      resetComposer();
      setMessage(wasEditing ? "Изменения сохранены, задача готова к новому запуску." : operationInfo.executable ? "Задача сохранена локально." : "Задача сохранена, но её backend пока не подключён — при запуске она будет честно помечена как blocked.");
      await refresh(false);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  function resetComposer() {
    setTitle(""); setPrompt(""); setPromptJson(""); setSeed(""); setAssets([]); setEditingId(null);
  }

  function loadItem(item: QueueItem, edit: boolean) {
    setOperation(item.operation);
    setTitle(item.title);
    setPrompt(item.prompt);
    setPromptJson(item.promptJson ? JSON.stringify(item.promptJson, null, 2) : "");
    setDuration(item.duration);
    setAspectRatio(item.aspectRatio);
    setVariants(item.variants);
    setSeed(item.seed === undefined ? "" : String(item.seed));
    setRenderMode(item.renderMode);
    setAssets(item.assets.map((asset) => ({ ...asset })));
    setEditingId(edit ? item.id : null);
    setMessage(edit ? `Редактируется «${item.title}». Исходники также загружены в форму.` : `Копия «${item.title}» загружена в форму. Оригинал остался в очереди.`);
  }

  async function importAsset(file: File, slot: AssetSlot, kind: AssetKind) {
    setBusy(true);
    setMessage(`Сохраняю ${file.name} локально…`);
    try {
      const dataBase64 = await fileBase64(file);
      const response = await apiFetch(`${apiBase}/api/assets/import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataBase64, kind })
      });
      const result = await response.json() as { path?: string; metadata?: { mimeType?: string }; error?: string };
      if (!response.ok || !result.path || !result.metadata?.mimeType) throw new Error(result.error ?? "Не удалось сохранить исходник.");
      const asset = { slot, kind, path: result.path, filename: file.name, mimeType: result.metadata.mimeType };
      setAssets((current) => [...current.filter((item) => item.slot !== slot), asset]);
      setMessage(`${file.name} сохранён локально и привязан к задаче.`);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  function dropAsset(event: DragEvent<HTMLLabelElement>, slot: AssetSlot, kind: AssetKind) {
    event.preventDefault();
    event.stopPropagation();
    setDragSlot(null);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!fileMatchesKind(file, kind)) {
      setMessage(`Для слота «${assetSlots[operation].find((item) => item.slot === slot)?.label ?? slot}» нужен файл типа ${kind}.`);
      return;
    }
    void importAsset(file, slot, kind);
  }

  function pasteAsset(data: DataTransfer, slot: AssetSlot, kind: AssetKind) {
    const file = clipboardFiles(data).map((candidate) => ensureClipboardFilename(candidate, kind)).find((candidate) => fileMatchesKind(candidate, kind));
    if (!file) {
      setMessage(`Для слота «${assetSlots[operation].find((item) => item.slot === slot)?.label ?? slot}» в буфере нет файла типа ${kind}.`);
      return;
    }
    void importAsset(file, slot, kind);
  }

  async function mutate(url: string, method: string, body?: unknown) {
    setBusy(true);
    try {
      const response = await apiFetch(`${apiBase}${url}`, {
        method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Операция с очередью не выполнена.");
      }
      await refresh(false);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function start(mode: "saved_worker" | "vast") {
    if (mode === "vast") {
      const ceiling = state?.vast.maxHourlyUsd ?? 1.2;
      const confirmed = window.confirm(`SnarkRoute подберёт Vast-сервер не дороже $${ceiling.toFixed(2)}/ч, выполнит очередь последовательно и затем УНИЧТОЖИТ точный instance. Продолжить аренду?`);
      if (!confirmed) return;
    }
    setBusy(true);
    setMessage(mode === "vast" ? "Ищу сервер. Если безопасного предложения нет, аренда не начнётся." : "Подключаю сохранённый worker…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/queue/session`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось запустить очередь.");
      await refresh(false);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function prepareVastTemplate() {
    setBusy(true);
    setMessage("Сохраняю секреты и создаю приватный H3 template в Vast…");
    try {
      const response = await apiFetch(`${apiBase}/api/h3/vast`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...vastForm,
          maxHourlyUsd: Number(vastForm.maxHourlyUsd),
          excludedCountryCodes: ["US", "GB", "KR", "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]
        })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить Vast-настройки.");
      const templateResponse = await apiFetch(`${apiBase}/api/h3/vast/template`, { method: "POST" });
      const templateResult = await templateResponse.json() as { template?: { hashId?: string }; error?: string };
      if (!templateResponse.ok || !templateResult.template?.hashId) throw new Error(templateResult.error ?? "Vast не вернул hash созданного шаблона.");
      setVastForm((current) => ({ ...current, apiKey: "", hfToken: "" }));
      setMessage(`Приватный H3 template создан и сохранён (${templateResult.template.hashId}). Автоматический запуск готов.`);
      await refresh(false);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  return (
    <section className="h3QueueSection">
      <header className="h3QueueHeader">
        <div><h2>Локальная очередь</h2><p>Сначала собери весь сценарий. GPU понадобится только на время пакетного рендера.</p></div>
        <span className="h3QueueCount">{state?.items.length ?? 0} задач</span>
      </header>

      <div className="h3QueueLayout">
        <div className="h3QueueComposer">
          {editingId ? <div className="h3EditingBanner"><span><Pencil size={14} /> Редактирование задания</span><button type="button" title="Отменить редактирование" onClick={resetComposer}><X size={14} /></button></div> : null}
          <div className="h3QueueTopFields">
            <div className="h3OperationField">
              <label><span>Операция</span><select value={operation} onChange={(event) => { setOperation(event.target.value as Operation); setAssets([]); pasteTarget.current = null; }}>{operations.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
              <p className={`h3OperationNote ${operationInfo.executable ? "" : "blocked"}`}>{operationInfo.executable ? <Check size={14} /> : <AlertTriangle size={14} />}{operationInfo.note}</p>
            </div>
            <label><span>Название задачи</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={operationInfo.label} /></label>
          </div>
          <div className="h3PromptFields">
            <label><span>Промпт</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Что должно произойти в сцене…" rows={4} /></label>
            <label><span>JSON-промпт от нейросети (необязательно)</span><textarea className="h3JsonPrompt" value={promptJson} onChange={(event) => setPromptJson(event.target.value)} placeholder={'{"scene": "…", "camera": "…"}'} rows={4} /></label>
          </div>
          <div className="h3QueueFields">
            <label><span>Секунд</span><input type="number" min={4} max={15} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>
            <label><span>Формат</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option><option>auto</option></select></label>
            <label><span>Вариантов</span><input type="number" min={1} max={10} value={variants} onChange={(event) => setVariants(Number(event.target.value))} /></label>
            <label><span>Режим</span><select value={renderMode} onChange={(event) => setRenderMode(event.target.value as "preview" | "final")}><option value="preview">Preview</option><option value="final">Final</option></select></label>
            <label><span>Seed · пусто = авто</span><div className="h3SeedField"><input type="number" min={0} max={2147483647} value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="Авто" /><button type="button" title="Новый случайный seed" onClick={() => setSeed(String(randomSeed()))}><Dices size={15} /></button></div></label>
          </div>
          {assetSlots[operation].length ? <div className="h3AssetSlots">{assetSlots[operation].map((definition) => {
            const attached = assets.find((item) => item.slot === definition.slot);
            return <label
              className={`h3AssetButton ${attached ? "hasPreview" : ""} ${dragSlot === definition.slot ? "dropActive" : ""}`}
              key={definition.slot}
              tabIndex={0}
              title="Кликни, перетащи файл или наведи курсор и нажми Ctrl+V"
              onMouseEnter={() => { pasteTarget.current = { slot: definition.slot, kind: definition.kind }; }}
              onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) pasteTarget.current = null; }}
              onFocus={() => { pasteTarget.current = { slot: definition.slot, kind: definition.kind }; }}
              onBlur={() => { pasteTarget.current = null; }}
              onDragEnter={(event) => { event.preventDefault(); setDragSlot(definition.slot); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragSlot(null); }}
              onDrop={(event) => dropAsset(event, definition.slot, definition.kind)}
            >
              {attached ? <AssetPreview asset={attached} /> : <span className="h3AssetUploadIcon"><Upload size={18} /></span>}
              <span className="h3AssetCaption"><strong>{definition.label}</strong><small>{attached?.filename ?? "Клик, перетащи или наведи + Ctrl+V"}</small></span>
              <input type="file" accept={`${definition.kind}/*`} disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importAsset(file, definition.slot, definition.kind); event.target.value = ""; }} />
            </label>;
          })}</div> : null}
          <button className="h3Primary h3AddQueue" type="button" disabled={busy || (!prompt.trim() && !promptJson.trim())} onClick={() => void submitItem()}>{editingId ? <Pencil size={16} /> : <ListPlus size={16} />} {editingId ? "Сохранить изменения" : "Добавить в очередь"}</button>
        </div>

        <div className="h3QueueList">
          {!state?.items.length ? <div className="h3QueueEmpty"><ListPlus size={30} /><strong>Очередь пуста</strong><span>Исходники и задания хранятся на этом компьютере.</span></div> : state.items.map((item, index) => <QueueCard key={item.id} item={item} index={index} count={state.items.length} busy={busy || sessionActive} onLoad={() => loadItem(item, false)} onEdit={() => loadItem(item, true)} onMutate={mutate} />)}
        </div>
      </div>

      {message ? <p className="h3QueueMessage">{message}</p> : null}
      <div className={`h3SessionBar ${state?.session.status === "cleanup_failed" ? "danger" : ""}`}>
        <SessionSummary session={state?.session} />
        <div className="h3SessionActions">
          {state?.session.status === "cleanup_failed" ? <button className="h3Danger" type="button" disabled={busy} onClick={() => void mutate("/api/h3/queue/session/cleanup", "POST")}><AlertTriangle size={15} /> Повторить уничтожение #{state.session.managedInstanceId}</button> : null}
          <button type="button" disabled={busy || sessionActive || !state?.items.length} onClick={() => void start("saved_worker")}><Play size={15} /> Рендер на подключённом H3</button>
          <button className="h3ManagedRun" type="button" disabled={busy || sessionActive || !state?.items.length || !state?.vast.configured} onClick={() => void start("vast")}><Cloud size={15} /> Арендовать → рендер → уничтожить</button>
        </div>
      </div>

      <button className={`h3AdvancedToggle ${vastOpen ? "open" : ""}`} type="button" onClick={() => setVastOpen((value) => !value)}><Settings2 size={15} /> Автоматическая аренда Vast <span>{state?.vast.configured ? "настроена" : "не настроена"}</span></button>
      {vastOpen ? <div className="h3VastConfig">
        <p>SnarkRoute сам создаст приватный Vast template, запустит worker и откроет локальный SSH-туннель. Терминал, Jupyter и внешний публичный H3-порт не понадобятся. Секреты сохраняются только локальным API и обратно не показываются.</p>
        <p><strong>Закреплено:</strong> {state?.vast.image || "образ загружается…"} · source {state?.vast.sourceRevision?.slice(0, 12) || "…"}</p>
        <div className="h3VastConfigGrid">
          <SecretInput label={`Vast API key${state?.vast.apiKeyConfigured ? " · сохранён" : ""}`} value={vastForm.apiKey} onChange={(value) => setVastForm((current) => ({ ...current, apiKey: value }))} />
          <SecretInput label={`HF token${state?.vast.hfTokenConfigured ? " · сохранён" : ""}`} value={vastForm.hfToken} onChange={(value) => setVastForm((current) => ({ ...current, hfToken: value }))} />
          <label><span>SSH private key{state?.vast.sshKeyConfigured ? " · найден" : ""}</span><input value={vastForm.sshPrivateKeyPath} onChange={(event) => setVastForm((current) => ({ ...current, sshPrivateKeyPath: event.target.value }))} placeholder="Обычно определяется из ~/.ssh/id_ed25519" /></label>
          <label><span>Предел $/час</span><input type="number" min="0.01" max="20" step="0.01" value={vastForm.maxHourlyUsd} onChange={(event) => setVastForm((current) => ({ ...current, maxHourlyUsd: event.target.value }))} /></label>
        </div>
        <label className="h3LicenseAccept"><input type="checkbox" checked={vastForm.acceptLicense} onChange={(event) => setVastForm((current) => ({ ...current, acceptLicense: event.target.checked }))} /><span>Я ознакомился и принимаю лицензию закреплённой модели MiniMax H3.</span></label>
        <button type="button" disabled={busy || !vastForm.acceptLicense} onClick={() => void prepareVastTemplate()}><Settings2 size={15} /> {state?.vast.templateHashConfigured ? "Пересоздать приватный H3 template" : "Подготовить автоматический запуск"}</button>
        {!state?.vast.sshKeyConfigured ? <p className="h3OperationNote blocked"><AlertTriangle size={14} /> Не найден локальный SSH-ключ, добавленный в аккаунт Vast. Укажи путь к private key.</p> : null}
      </div> : null}
    </section>
  );
}

function QueueCard({ item, index, count, busy, onLoad, onEdit, onMutate }: { item: QueueItem; index: number; count: number; busy: boolean; onLoad: () => void; onEdit: () => void; onMutate: (url: string, method: string, body?: unknown) => Promise<void> }) {
  const label = operations.find((operation) => operation.value === item.operation)?.label ?? item.operation;
  return <article className={`h3QueueCard ${item.status}`}>
    <div className="h3QueueCardTop"><div><span>{index + 1}. {label}</span><strong>{item.title}</strong></div><div className="h3QueueCardButtons"><button title="Во ввод как копию" onClick={onLoad}><CopyPlus size={14} /></button><button disabled={busy || item.status === "running"} title="Редактировать" onClick={onEdit}><Pencil size={14} /></button><button disabled={busy || index === 0} title="Выше" onClick={() => void onMutate(`/api/h3/queue/${item.id}/move`, "POST", { direction: "up" })}><ArrowUp size={14} /></button><button disabled={busy || index === count - 1} title="Ниже" onClick={() => void onMutate(`/api/h3/queue/${item.id}/move`, "POST", { direction: "down" })}><ArrowDown size={14} /></button><button disabled={busy} title="Удалить" onClick={() => void onMutate(`/api/h3/queue/${item.id}`, "DELETE")}><Trash2 size={14} /></button></div></div>
    <p>{item.prompt}</p>
    <div className="h3QueueMeta"><span>{item.duration} с</span><span>{item.aspectRatio}</span><span>{item.variants} вар.</span><span>{item.renderMode}</span><span>seed {item.seed ?? "—"}</span>{item.assets.map((asset) => <span key={asset.slot}>{asset.filename}</span>)}</div>
    <div className="h3QueueProgress"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>
    <footer><strong>{statusLabel(item.status)}{item.stage ? ` · ${item.stage}` : ""}</strong>{item.error ? <span>{item.error}</span> : null}{item.resultPaths?.map((path, resultIndex) => <a key={path} href={`${apiBase}/api/assets/preview?kind=video&path=${encodeURIComponent(path)}`} target="_blank" rel="noreferrer"><Download size={13} /> Результат {resultIndex + 1}</a>)}</footer>
  </article>;
}

function SessionSummary({ session }: { session?: QueueSession }) {
  if (!session || session.status === "idle") return <div><strong>Пакетный запуск</strong><span>Задачи выполняются строго по одной.</span></div>;
  return <div><strong>Сессия: {sessionLabel(session.status)}</strong><span>{session.managedInstanceId ? `Vast instance #${session.managedInstanceId}` : session.mode === "saved_worker" ? "Сохранённый worker не удаляется" : "Instance ещё не создан"}{session.hourlyPriceUsd ? ` · $${session.hourlyPriceUsd.toFixed(3)}/ч` : ""}{session.cleanupConfirmed === true ? " · удаление подтверждено" : ""}</span>{session.error ? <span>{session.error}</span> : null}</div>;
}

function SecretInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label><span>{label}</span><input type="password" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Оставь пустым, чтобы не менять" /></label>; }
function AssetPreview({ asset }: { asset: QueueAsset }) {
  const src = `${apiBase}/api/assets/preview?kind=${asset.kind}&path=${encodeURIComponent(asset.path)}`;
  if (asset.kind === "image") return <img className="h3AssetPreview" src={src} alt="" />;
  if (asset.kind === "video") return <video className="h3AssetPreview" src={src} muted playsInline preload="metadata" />;
  return <audio className="h3AssetAudioPreview" src={src} controls preload="metadata" onClick={(event) => event.stopPropagation()} />;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function statusLabel(status: ItemStatus): string { return ({ ready: "готово к запуску", running: "рендеринг", succeeded: "готово", failed: "ошибка", blocked: "backend не подключён" })[status]; }
function sessionLabel(status: SessionStatus): string { return ({ idle: "ожидание", connecting: "подключение", rendering: "рендеринг", cleaning: "уничтожение сервера", completed: "завершено", completed_with_errors: "завершено с ошибками", failed: "ошибка запуска", cleanup_failed: "УНИЧТОЖЕНИЕ НЕ ПОДТВЕРЖДЕНО" })[status]; }
function fileBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? ""); reader.onerror = () => reject(reader.error ?? new Error("File read failed.")); reader.readAsDataURL(file); }); }
function randomSeed(): number { const value = new Uint32Array(1); crypto.getRandomValues(value); return (value[0] ?? 0) % 2_147_483_648; }
function clipboardFiles(data: DataTransfer): File[] {
  const files = [...Array.from(data.files)];
  for (const item of Array.from(data.items)) {
    const file = item.kind === "file" ? item.getAsFile() : null;
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}
function ensureClipboardFilename(file: File, kind: AssetKind): File {
  if (/\.[a-z0-9]{2,5}$/i.test(file.name)) return file;
  const extensionByMime: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac"
  };
  const extension = extensionByMime[file.type] ?? (!file.type ? ({ image: "png", video: "mp4", audio: "wav" } as const)[kind] : "");
  if (!extension) return file;
  const mimeType = file.type || ({ image: "image/png", video: "video/mp4", audio: "audio/wav" } as const)[kind];
  return new File([file], `clipboard-${Date.now()}.${extension}`, { type: mimeType, lastModified: file.lastModified || Date.now() });
}
function fileMatchesKind(file: File, kind: AssetKind): boolean {
  if (file.type.startsWith(`${kind}/`)) return true;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "image") return ["png", "jpg", "jpeg", "webp"].includes(extension);
  if (kind === "video") return ["mp4", "mov", "m4v", "webm", "mkv"].includes(extension);
  return ["wav", "mp3", "flac", "ogg", "m4a", "aac"].includes(extension);
}
