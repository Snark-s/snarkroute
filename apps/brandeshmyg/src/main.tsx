import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasActionHost, createToolTab, persistToolTab, updateToolTab, type CanvasNodeAction, type PersistedToolTabState, type ToolTabState } from "@snarkroute/canvas-action-host";
import { ChevronLeft, ChevronRight, FilePlus2, Plus, Search, X } from "lucide-react";
import { disposeSession, installPackage, loadActions, previewPackage, runSession } from "./api";
import "./styles.css";

const tabsKey = "brandeshmyg.tabs.v1";
const activeKey = "brandeshmyg.activeTab.v1";

function App() {
  const [actions, setActions] = useState<CanvasNodeAction[]>([]);
  const [tabs, setTabs] = useState<ToolTabState[]>(restoreTabs);
  const [activeId, setActiveId] = useState(() => localStorage.getItem(activeKey) ?? "");
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [importState, setImportState] = useState<{ file: File; preview?: Record<string, unknown>; error?: string }>();
  const importRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try { setActions(await loadActions()); setRuntimeError(""); }
    catch { setRuntimeError("SnarkRoute Runtime не запущен"); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { localStorage.setItem(tabsKey, JSON.stringify(tabs.map(persistToolTab))); }, [tabs]);
  useEffect(() => { if (activeId) localStorage.setItem(activeKey, activeId); }, [activeId]);
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("action");
    if (requested && actions.some((action) => action.id === requested) && !tabs.some((tab) => tab.actionId === requested)) openAction(requested);
  }, [actions]);

  const filtered = useMemo(() => actions.filter((action) => `${action.title} ${action.description}`.toLowerCase().includes(search.toLowerCase())), [actions, search]);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const action = active ? actions.find((candidate) => candidate.id === active.actionId) : undefined;

  function openAction(actionId: string) {
    const found = actions.find((candidate) => candidate.id === actionId);
    if (!found) return;
    const id = crypto.randomUUID();
    setTabs((current) => [...current, createToolTab(found, id)]);
    setActiveId(id);
  }

  function closeTab(id: string) {
    void disposeSession(id).catch(() => undefined);
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeId === id) setActiveId(next.at(-1)?.id ?? "");
      return next;
    });
  }

  async function run(tab: ToolTabState, action: CanvasNodeAction) {
    setTabs((current) => updateToolTab(current, tab.id, { status: "running", error: undefined }));
    try {
      const interactive = Boolean(action.dialog?.preview?.some((preview) => typeof preview.source === "object" && "pause" in preview.source));
      const response = await runSession({ sessionId: tab.id, actionId: action.id, toolInput: tab.input, params: tab.params, phase: tab.continuationId ? "complete" : interactive ? "prepare" : undefined, continuationId: tab.continuationId });
      setTabs((current) => updateToolTab(current, tab.id, response.status === "paused"
        ? { status: "paused", continuationId: response.continuationId, preparedPreviews: response.previews }
        : { status: "completed", continuationId: undefined, preparedPreviews: undefined, results: response.results }));
    } catch (error) {
      setTabs((current) => updateToolTab(current, tab.id, { status: "error", error: error instanceof Error ? error.message : "Action failed." }));
    }
  }

  async function choosePackage(file?: File) {
    if (!file) return;
    setImportState({ file });
    try { setImportState({ file, preview: await previewPackage(file) }); }
    catch (error) { setImportState({ file, error: error instanceof Error ? error.message : "Package validation failed." }); }
  }

  async function confirmInstall() {
    if (!importState?.file) return;
    try { await installPackage(importState.file); setImportState(undefined); await refresh(); }
    catch (error) { setImportState({ ...importState, error: error instanceof Error ? error.message : "Install failed." }); }
  }

  return <div className="appShell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const file = event.dataTransfer.files[0]; if (file?.name.toLowerCase().endsWith(".node.json")) void choosePackage(file); }}>
    <header className="topbar"><div className="brand"><span>Б</span><div><strong>Брандешмыг</strong><small>Canvas Actions as tools</small></div></div>{runtimeError ? <div className="runtimeError">{runtimeError}<code>corepack pnpm start:brandeshmyg</code><button onClick={() => void refresh()}>Retry</button></div> : <span className="runtimeOk">Runtime connected</span>}</header>
    <div className="workspace">
      <aside className={libraryOpen ? "library open" : "library"}>
        <button className="collapse" onClick={() => setLibraryOpen(!libraryOpen)}>{libraryOpen ? <ChevronLeft /> : <ChevronRight />}</button>
        {libraryOpen ? <><h2>Tools</h2><label className="search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tools" /></label><div className="toolList">{filtered.map((item) => <button key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("application/x-brandeshmyg-action", item.id)} onClick={() => openAction(item.id)}><ActionIcon action={item} /><span><strong>{item.title}</strong><small>{item.description}</small></span></button>)}</div><button className="importButton" onClick={() => importRef.current?.click()}><FilePlus2 size={17} /> Import .node.json</button><input ref={importRef} hidden type="file" accept=".json,.node.json,.snarknode" onChange={(event) => void choosePackage(event.target.files?.[0])} /></> : null}
      </aside>
      <section className="toolArea">
        <nav className="tabs" onDragOver={(event) => event.preventDefault()} onDrop={(event) => openAction(event.dataTransfer.getData("application/x-brandeshmyg-action"))}>{tabs.map((tab) => <button key={tab.id} className={tab.id === active?.id ? "active" : ""} onClick={() => setActiveId(tab.id)}><span>{tab.title}</span><X size={14} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} /></button>)}<button className="addTab" title="Open tool library" onClick={() => setLibraryOpen(true)}><Plus size={18} /></button></nav>
        {active && action ? <CanvasActionHost action={action} tab={active} onChange={(next) => setTabs((current) => current.map((tab) => tab.id === next.id ? next : tab))} onRun={() => void run(active, action)} header={<header className="toolHeader"><ActionIcon action={action} /><div><h1>{action.title}</h1><p>{action.description}</p></div></header>} /> : <div className="empty"><div className="emptyMark">Б</div><h1>Open a tool</h1><p>Choose an installed Canvas Action or import an existing .node.json package.</p><button onClick={() => setLibraryOpen(true)}><Plus size={18} /> Choose tool</button></div>}
      </section>
    </div>
    {importState ? <div className="modalBackdrop"><section className="importModal"><header><h2>Install tool package</h2><button onClick={() => setImportState(undefined)}><X /></button></header><p><strong>{importState.file.name}</strong></p>{importState.preview ? <PackagePreview preview={importState.preview} /> : !importState.error ? <p>Validating…</p> : null}{importState.error ? <pre className="canvasActionError">{importState.error}</pre> : null}<footer><button onClick={() => setImportState(undefined)}>Cancel</button><button className="primary" disabled={!importState.preview} onClick={() => void confirmInstall()}>Install</button></footer></section></div> : null}
  </div>;
}

function ActionIcon({ action }: { action: CanvasNodeAction }) {
  if (action.icon?.kind === "custom" && action.icon.dataUrl) return <img className="actionIcon" src={action.icon.dataUrl} alt="" />;
  return <span className="actionIcon preset">{action.title.slice(0, 1).toUpperCase()}</span>;
}

function PackagePreview({ preview }: { preview: Record<string, unknown> }) {
  const manifest = preview.manifest && typeof preview.manifest === "object" ? preview.manifest as Record<string, unknown> : {};
  const author = manifest.author && typeof manifest.author === "object" ? (manifest.author as Record<string, unknown>).name : "";
  return <dl className="packagePreview"><dt>Name</dt><dd>{String(manifest.title ?? manifest.id ?? "Unknown")}</dd><dt>Author</dt><dd>{String(author ?? "Unknown")}</dd><dt>Version</dt><dd>{String(manifest.version ?? "")}</dd><dt>Input</dt><dd>{JSON.stringify(manifest.inputs ?? [])}</dd><dt>Outputs</dt><dd>{JSON.stringify(manifest.outputs ?? [])}</dd><dt>Parameters</dt><dd>{JSON.stringify(manifest.params ?? [])}</dd><dt>Permissions</dt><dd>{JSON.stringify(manifest.permissions ?? {})}</dd><dt>Warnings</dt><dd>{JSON.stringify(preview.warnings ?? [])}</dd></dl>;
}

function restoreTabs(): ToolTabState[] {
  try { return JSON.parse(localStorage.getItem(tabsKey) ?? "[]") as PersistedToolTabState[]; }
  catch { return []; }
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
