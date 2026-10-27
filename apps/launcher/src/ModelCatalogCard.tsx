import { ArrowUpRight, Boxes, ChevronRight, LoaderCircle, RefreshCw, Save, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

// Model Catalog V1 by type, plus which models other networks (MCP: Codex, Claude, ChatGPT) receive.
// The server owns the policy and enforces it in Model Gateway; the card only edits a draft.
type Policy = { version: 1; localOnly: boolean; selectedOnly: boolean; providers: string[]; models: string[]; updatedAt?: string };
type Model = { id: string; provider: string; providerModelId: string; displayName: string; type: string; local: boolean; available: boolean; exposed: boolean };
type ProviderGroup = { provider: string; local: boolean; models: Model[] };
type TypeGroup = { type: string; label: string; modelCount: number; providers: ProviderGroup[] };
type Summary = { models: number; providers: number; localModels: number; exposedModels: number; exposedAvailableModels: number; exposedProviders: number };
type View = { policy: Policy; summary: Summary; groups: TypeGroup[] };

const PAGE = 150;

async function call<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

function exposed(policy: Policy, model: Model) {
  return (!policy.localOnly || model.local)
    && (!policy.selectedOnly || policy.providers.includes(model.provider) || policy.models.includes(model.id));
}

const toggle = (list: string[], value: string, on: boolean) => on ? [...new Set([...list, value])] : list.filter(item => item !== value);
const samePolicy = (a: Policy, b: Policy) => a.localOnly === b.localOnly && a.selectedOnly === b.selectedOnly
  && [...a.providers].sort().join("\n") === [...b.providers].sort().join("\n") && [...a.models].sort().join("\n") === [...b.models].sort().join("\n");

export function ModelCatalogCard({ apiBase, index }: { apiBase: string; index: number }) {
  const [view, setView] = useState<View>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try { setView(await call<View>(apiBase, "/api/system/model-exposure", { signal: AbortSignal.timeout(60_000) })); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Каталог недоступен"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [apiBase]);

  const summary = view?.summary;
  const policy = view?.policy;
  const mode = !policy ? "" : policy.localOnly && policy.selectedOnly ? "локальные и выбранные" : policy.localOnly ? "только локальные" : policy.selectedOnly ? "только выбранные" : "все модели";
  return <>
    <div className="appCard violet modelsCard" style={{ animationDelay: `${index * 55}ms` }}>
      <button className="cardMain" onClick={() => setOpen(true)} title="Все модели и провайдеры SnarkRoute">
        <span className="cardGlow" />
        <span className="appIcon"><Boxes /></span>
        <span className="appCopy"><strong>Модели и провайдеры</strong><small>{summary ? `${summary.models} моделей · ${summary.providers} провайдеров · ${summary.localModels} локальных` : error || "Загрузка каталога…"}</small></span>
        <span className="cardFooter">
          <span className={summary ? "status on" : "status"} title="Что получают другие сети через MCP">{summary ? `Внешним сетям: ${summary.exposedAvailableModels} · ${mode}` : "…"}</span>
          {loading && !view ? <LoaderCircle className="spin" /> : <ArrowUpRight />}
        </span>
      </button>
    </div>
    {open ? <ModelCatalogDialog apiBase={apiBase} view={view} loading={loading} error={error} onReload={() => void load()} onSaved={setView} onClose={() => setOpen(false)} /> : null}
  </>;
}

function ModelCatalogDialog({ apiBase, view, loading, error, onReload, onSaved, onClose }: {
  apiBase: string; view?: View; loading: boolean; error: string; onReload: () => void; onSaved: (view: View) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<Policy | undefined>(view?.policy);
  const [type, setType] = useState(view?.groups[0]?.type ?? "");
  const [query, setQuery] = useState("");
  const [onlyShared, setOnlyShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => { if (view && !draft) setDraft(view.policy); if (view && !type) setType(view.groups[0]?.type ?? ""); }, [view]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty = Boolean(view && draft && !samePolicy(view.policy, draft));
  const all = useMemo(() => view?.groups.flatMap(group => group.providers.flatMap(provider => provider.models)) ?? [], [view]);
  const sharedCount = draft ? all.filter(model => model.available && exposed(draft, model)).length : 0;
  const group = view?.groups.find(item => item.type === type);
  const needle = query.trim().toLowerCase();
  const providers = (group?.providers ?? []).map(provider => ({
    ...provider,
    models: provider.models.filter(model => (!needle || `${model.displayName} ${model.providerModelId} ${model.provider}`.toLowerCase().includes(needle))
      && (!onlyShared || !draft || exposed(draft, model)))
  })).filter(provider => provider.models.length || (!needle && !onlyShared));

  async function save() {
    if (!draft) return;
    setSaving(true); setSaveError("");
    try {
      const next = await call<View>(apiBase, "/api/system/model-exposure", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal: AbortSignal.timeout(60_000) });
      onSaved(next); setDraft(next.policy);
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : "Не сохранено"); }
    finally { setSaving(false); }
  }

  return <div className="modelsOverlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modelsDialog" role="dialog" aria-modal="true" aria-labelledby="models-dialog-title">
      <header className="modelsHead">
        <div><h2 id="models-dialog-title">Модели и провайдеры</h2>
          <p>{view ? `${view.summary.models} моделей у ${view.summary.providers} провайдеров. Внешним сетям (Codex, Claude, ChatGPT через MCP) отдаётся ${sharedCount} доступных.` : error || "Загрузка…"}</p></div>
        <div className="modelsHeadActions">
          <button type="button" onClick={onReload} disabled={loading} title="Перечитать живой каталог">{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}</button>
          <button type="button" onClick={onClose} title="Закрыть (Esc)"><X /></button>
        </div>
      </header>
      {draft ? <div className="modelsPolicy">
        <span className="modelsPolicyTitle">Отдавать другим сетям</span>
        <label><input type="checkbox" checked={draft.localOnly} onChange={event => setDraft({ ...draft, localOnly: event.target.checked })} /> только локальные</label>
        <label><input type="checkbox" checked={draft.selectedOnly} onChange={event => setDraft({ ...draft, selectedOnly: event.target.checked })} /> только выбранные</label>
        <span className="modelsPolicyHint">{draft.selectedOnly ? `Выбрано: ${draft.providers.length} провайдеров, ${draft.models.length} моделей` : "Отметки ниже начнут действовать с «только выбранные»"}</span>
        <button type="button" className="modelsSave" onClick={() => void save()} disabled={!dirty || saving}>{saving ? <LoaderCircle className="spin" /> : <Save />} {dirty ? "Сохранить" : "Сохранено"}</button>
        {saveError ? <span className="modelsError">{saveError}</span> : null}
      </div> : null}
      {view ? <>
        <div className="modelsTypes" role="tablist" aria-label="Типы моделей">
          {view.groups.map(item => <button type="button" role="tab" key={item.type} aria-selected={item.type === type} onClick={() => setType(item.type)}>
            {item.label}<span>{draft ? item.providers.reduce((sum, provider) => sum + provider.models.filter(model => exposed(draft, model)).length, 0) : 0}/{item.modelCount}</span>
          </button>)}
        </div>
        <div className="modelsFilters">
          <label className="modelsSearch"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск модели или провайдера" /></label>
          <label><input type="checkbox" checked={onlyShared} onChange={event => setOnlyShared(event.target.checked)} /> только отдаваемые</label>
        </div>
        <div className="modelsProviders">
          {providers.length === 0 ? <p className="modelsEmpty">Ничего не найдено.</p> : providers.map(provider => draft
            ? <ProviderRow key={`${type}:${provider.provider}`} provider={provider} draft={draft} setDraft={setDraft} expanded={Boolean(needle)} />
            : null)}
        </div>
      </> : null}
    </section>
  </div>;
}

function ProviderRow({ provider, draft, setDraft, expanded }: { provider: ProviderGroup; draft: Policy; setDraft: (policy: Policy) => void; expanded: boolean }) {
  const [open, setOpen] = useState(expanded);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setOpen(expanded), [expanded]);
  const providerSelected = draft.providers.includes(provider.provider);
  const shared = provider.models.filter(model => exposed(draft, model)).length;
  const available = provider.models.filter(model => model.available).length;
  return <div className={`modelsProvider ${open ? "open" : ""}`}>
    <div className="modelsProviderRow">
      <button type="button" className="modelsExpand" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? "Свернуть" : "Показать модели"}><ChevronRight /></button>
      <label className="modelsProviderName" title="Выбрать провайдера целиком (все его модели)">
        <input type="checkbox" checked={providerSelected} onChange={event => setDraft({ ...draft, providers: toggle(draft.providers, provider.provider, event.target.checked) })} />
        <b>{provider.provider}</b>
      </label>
      <span className={`modelsBadge ${provider.local ? "local" : "cloud"}`}>{provider.local ? "локальный" : "облачный"}</span>
      <span className="modelsCount">{provider.models.length} моделей · {available} доступно · <em className={shared ? "on" : ""}>{shared} отдаётся</em></span>
    </div>
    {open ? <ul className="modelsList">
      {provider.models.slice(0, limit).map(model => {
        const on = exposed(draft, model);
        return <li key={model.id} className={`${model.available ? "" : "offline"} ${on ? "shared" : ""}`}>
          <label title={providerSelected ? "Выбран весь провайдер" : model.id}>
            <input type="checkbox" checked={providerSelected || draft.models.includes(model.id)} disabled={providerSelected}
              onChange={event => setDraft({ ...draft, models: toggle(draft.models, model.id, event.target.checked) })} />
            <span className="modelsName">{model.displayName}</span>
            <code>{model.providerModelId}</code>
          </label>
          <span className="modelsState">{!model.available ? "недоступна" : on ? "отдаётся" : "скрыта"}</span>
        </li>;
      })}
      {provider.models.length > limit ? <li className="modelsMore"><button type="button" onClick={() => setLimit(limit + PAGE)}>Показать ещё {Math.min(PAGE, provider.models.length - limit)} из {provider.models.length - limit}</button></li> : null}
    </ul> : null}
  </div>;
}
