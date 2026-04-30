import "@xyflow/react/dist/style.css";
import "./styles.css";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps
} from "@xyflow/react";
import { ChevronLeft, ChevronRight, Download, FileJson, KeyRound, PanelLeftClose, PanelRightClose, Play, Plus, Save, Trash2, Upload, Wand2 } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type RouteDoc = {
  routeVersion: string;
  route: { id: string; title: string; description?: string; author: Record<string, unknown>; tags?: string[] };
  economics: Record<string, unknown>;
  nodes: Array<{ id: string; type: string; title?: string; params?: Record<string, unknown>; ui?: Record<string, unknown> }>;
  edges: Array<{ id?: string; from: string; to: string }>;
  provenance?: Record<string, unknown>;
};

type NodeRunResult = {
  status?: string;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

type RunDisplayResult = {
  runId?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  nodeResults?: Record<string, NodeRunResult>;
  logs?: Array<{ timestamp?: string; nodeId?: string; message: string }>;
  error?: string;
};

type AssetKind = "file" | "image" | "video";

const apiBase = "";

const library = [
  { type: "input.text", label: "Text Input", params: { value: "A small route prompt" } },
  { type: "input.file", label: "Input File", params: { path: "" } },
  { type: "input.image", label: "Input Image", params: { path: "" } },
  { type: "input.video", label: "Input Video", params: { path: "" } },
  { type: "transform.template", label: "Template Transform", params: { template: "{{input_prompt.output.text}}" } },
  { type: "replicate.model", label: "Replicate Model", params: { model: "black-forest-labs/flux-schnell", input: { prompt: "{{input_prompt.output.text}}" } } },
  { type: "debug.log", label: "Debug Log", params: { message: "Debug value", value: "{{input_prompt.output.text}}" } },
  { type: "output.file", label: "Output File", params: { filename: "output.json", from: "{{debug.output.value}}" } }
];

const exampleRoute: RouteDoc = {
  routeVersion: "0.1",
  route: { id: "debug-basic", title: "Debug Basic", author: { name: "SnarkRoute" }, tags: ["debug", "local"] },
  economics: { enabled: false, notes: "Economics metadata is preserved even when disabled." },
  nodes: [
    { id: "input_prompt", type: "input.text", title: "Prompt", params: { value: "Hello from Open Route Protocol" }, ui: { x: 80, y: 80 } },
    { id: "template", type: "transform.template", title: "Template", params: { template: "Route says: {{input_prompt.output.text}}" }, ui: { x: 370, y: 80 } },
    { id: "debug", type: "debug.log", title: "Debug", params: { value: "{{template.output.text}}" }, ui: { x: 660, y: 80 } },
    { id: "output", type: "output.file", title: "Output", params: { filename: "debug-output.txt", from: "{{debug.output.value}}" }, ui: { x: 950, y: 80 } }
  ],
  edges: [
    { from: "input_prompt", to: "template" },
    { from: "template", to: "debug" },
    { from: "debug", to: "output" }
  ],
  provenance: { tool: "snarkroute-studio" }
};

function RouteNodeCard({ id, data }: NodeProps) {
  const label = String(data.label ?? "");
  const [title, type] = label.split("\n");
  const routeNode = data.routeNode as RouteDoc["nodes"][number] | undefined;
  const params = routeNode?.params ?? {};
  const result = data.result as NodeRunResult | undefined;
  const onParamsChange = data.onParamsChange as ((nodeId: string, params: Record<string, unknown>) => void) | undefined;
  const onBrowseAsset = data.onBrowseAsset as ((nodeId: string, kind: AssetKind) => void) | undefined;
  const ports = getNodePorts(type);

  function patchParams(patch: Record<string, unknown>) {
    onParamsChange?.(id, { ...params, ...patch });
  }

  return (
    <div className="routeNodeCard">
      <span className={`nodeStatus ${statusClass(result?.status)}`} />
      {ports.inputs.map((port, index) => (
        <Handle
          key={port.id}
          className={`typedHandle ${port.kind}`}
          id={port.id}
          type="target"
          position={Position.Left}
          style={{ top: `${42 + index * 28}px` }}
          title={`${port.id}: ${port.kind}`}
        />
      ))}
      <div className="nodeTitle">{title}</div>
      <div className="nodeType">{type}</div>
      <NodeInlineParams type={type} params={params} onChange={patchParams} onBrowse={(kind) => onBrowseAsset?.(id, kind)} />
      {result ? <NodeInlineResult result={result} /> : null}
      {ports.outputs.map((port, index) => (
        <Handle
          key={port.id}
          className={`typedHandle ${port.kind}`}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: `${42 + index * 28}px` }}
          title={`${port.id}: ${port.kind}`}
        />
      ))}
    </div>
  );
}

function NodeInlineParams({
  type,
  params,
  onChange,
  onBrowse
}: {
  type: string;
  params: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  onBrowse: (kind: AssetKind) => void;
}) {
  if (type === "input.text") {
    return (
      <label className="nodeField">
        <span>value</span>
        <textarea className="nodrag nopan nodeTextarea" value={String(params.value ?? "")} onChange={(event) => onChange({ value: event.target.value })} />
      </label>
    );
  }

  if (type === "transform.template") {
    return (
      <label className="nodeField">
        <span>template</span>
        <textarea className="nodrag nopan nodeTextarea" value={String(params.template ?? "")} onChange={(event) => onChange({ template: event.target.value })} />
      </label>
    );
  }

  if (type === "input.file" || type === "input.image" || type === "input.video") {
    const kind = type.split(".")[1] as AssetKind;
    const path = String(params.path ?? "");
    return (
      <div className="assetParams">
        <label className="nodeField">
          <span>path</span>
          <input className="nodrag nopan nodeInput" value={path} onChange={(event) => onChange({ path: event.target.value })} />
        </label>
        <button className="nodeSmallButton nodrag nopan" onClick={() => onBrowse(kind)}>Browse...</button>
        {!path ? <div className="nodeWarning">Path required</div> : null}
        {type === "input.image" && path ? <img className="nodeImagePreview" src={`${apiBase}/api/assets/preview?path=${encodeURIComponent(path)}`} alt="" /> : null}
      </div>
    );
  }

  if (type === "replicate.model") {
    return (
      <>
        <label className="nodeField">
          <span>model</span>
          <input className="nodrag nopan nodeInput" value={String(params.model ?? "")} onChange={(event) => onChange({ model: event.target.value })} />
        </label>
        <label className="nodeField">
          <span>input</span>
          <textarea
            className="nodrag nopan nodeTextarea"
            value={JSON.stringify(params.input ?? {}, null, 2)}
            onChange={(event) => {
              try {
                onChange({ input: JSON.parse(event.target.value) });
              } catch {
                onChange({ input: event.target.value });
              }
            }}
          />
        </label>
      </>
    );
  }

  if (type === "debug.log") {
    return (
      <>
        <label className="nodeField">
          <span>message</span>
          <input className="nodrag nopan nodeInput" value={String(params.message ?? "")} onChange={(event) => onChange({ message: event.target.value })} />
        </label>
        <label className="nodeField">
          <span>value</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.value ?? "")} onChange={(event) => onChange({ value: event.target.value })} />
        </label>
      </>
    );
  }

  if (type === "output.file") {
    return (
      <>
        <label className="nodeField">
          <span>filename</span>
          <input className="nodrag nopan nodeInput" value={String(params.filename ?? "")} onChange={(event) => onChange({ filename: event.target.value })} />
        </label>
        <label className="nodeField">
          <span>from</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.from ?? "")} onChange={(event) => onChange({ from: event.target.value })} />
        </label>
      </>
    );
  }

  return null;
}

function NodeInlineResult({ result }: { result: NodeRunResult }) {
  const preview = truncateText(result.error ?? JSON.stringify(result.output ?? {}, null, 2), 420);
  return (
    <div className={`nodeResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
      <div>{result.status ?? "unknown"}</div>
      <pre>{preview}</pre>
    </div>
  );
}

function statusClass(status?: string): string {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "pending") return "pending";
  return "";
}

const nodeTypes = {
  route: RouteNodeCard
};

type PortKind = "text" | "image" | "video" | "file" | "data";

type PortSpec = {
  id: string;
  kind: PortKind;
};

function getNodePorts(type: string): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (type === "input.text") return { inputs: [], outputs: [{ id: "text", kind: "text" }] };
  if (type === "input.file") return { inputs: [], outputs: [{ id: "file", kind: "file" }] };
  if (type === "input.image") return { inputs: [], outputs: [{ id: "image", kind: "image" }] };
  if (type === "input.video") return { inputs: [], outputs: [{ id: "video", kind: "video" }] };
  if (type === "replicate.model") return { inputs: [{ id: "input", kind: "data" }], outputs: [{ id: "output", kind: "data" }] };
  if (type === "output.file") return { inputs: [{ id: "from", kind: "data" }], outputs: [] };
  if (type === "transform.template") return { inputs: [{ id: "template", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "debug.log") return { inputs: [{ id: "value", kind: "data" }], outputs: [{ id: "value", kind: "data" }] };
  return { inputs: [{ id: "input", kind: "data" }], outputs: [{ id: "output", kind: "data" }] };
}

function arePortsCompatible(source: PortKind, target: PortKind): boolean {
  if (source === "data" || target === "data") return true;
  return source === target;
}

function describeConnection(connection: Connection): string {
  return `${connection.source ?? "unknown"}.${connection.sourceHandle ?? "output"} -> ${connection.target ?? "unknown"}.${connection.targetHandle ?? "input"}`;
}

function routeToFlow(route: RouteDoc): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: route.nodes.map((node, index) => ({
      id: node.id,
      type: "route",
      position: { x: Number(node.ui?.x ?? 80 + index * 240), y: Number(node.ui?.y ?? 120) },
      data: { label: `${node.title ?? node.id}\n${node.type}`, routeNode: node }
    })),
    edges: route.edges.map((edge, index) => ({ id: edge.id ?? `${edge.from}-${edge.to}-${index}`, source: edge.from, target: edge.to }))
  };
}

function flowToRoute(nodes: Node[], edges: Edge[], baseRoute: RouteDoc): RouteDoc {
  return {
    routeVersion: baseRoute.routeVersion,
    route: baseRoute.route,
    economics: baseRoute.economics,
    nodes: nodes.map((node) => {
      const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
      return { ...routeNode, ui: { ...(routeNode.ui ?? {}), x: node.position.x, y: node.position.y } };
    }),
    edges: edges.map((edge) => ({ id: edge.id, from: edge.source, to: edge.target })),
    provenance: { tool: "snarkroute-studio", updatedAt: new Date().toISOString() }
  };
}

function App() {
  const initial = useMemo(() => routeToFlow(exampleRoute), []);
  const [routeBase, setRouteBase] = useState<RouteDoc>(exampleRoute);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paramsText, setParamsText] = useState("{}");
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>(["SnarkRoute Studio ready."]);
  const [outputs, setOutputs] = useState<unknown>(null);
  const [runResult, setRunResult] = useState<RunDisplayResult | null>(null);
  const [replicateToken, setReplicateToken] = useState("");
  const [replicateConfigured, setReplicateConfigured] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [pendingBrowse, setPendingBrowse] = useState<{ nodeId: string; kind: AssetKind } | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const selectedNode = nodes.find((node) => node.id === selectedId);
  const selectedNodeCount = nodes.filter((node) => node.selected).length;
  const selectedEdgeCount = edges.filter((edge) => edge.selected).length;
  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onParamsChange: updateNodeParams,
          onBrowseAsset: browseAsset,
          result: runResult?.nodeResults?.[node.id]
        }
      })),
    [nodes, runResult]
  );

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const response = await fetch(`${apiBase}/api/settings`);
      const result = await response.json();
      setReplicateConfigured(Boolean(result.replicateConfigured));
    } catch {
      setSettingsMessage("Settings API unavailable.");
    }
  }

  async function saveReplicateToken() {
    const token = replicateToken.trim();
    if (!token) {
      setSettingsMessage("Token cannot be empty.");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/replicate-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replicateApiToken: token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save token.");
      setReplicateConfigured(Boolean(result.replicateConfigured));
      setReplicateToken("");
      setSettingsMessage("Replicate token saved locally.");
      setLogs((current) => ["Replicate token saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function browseAsset(nodeId: string, kind: AssetKind) {
    setPendingBrowse({ nodeId, kind });
    setTimeout(() => document.getElementById("asset-file-picker")?.click(), 0);
  }

  async function applyLocalFile(nodeId: string, file: File, kind: AssetKind) {
    const path = await importLocalAsset(file, kind);
    const current = nodes.find((node) => node.id === nodeId)?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    updateNodeParams(nodeId, { ...(current?.params ?? {}), path });
    setLogs((entries) => [`Selected ${kind}: ${path}`, ...entries]);
  }

  async function handleFallbackFile(file: File | null) {
    if (!file || !pendingBrowse) return;
    try {
      await applyLocalFile(pendingBrowse.nodeId, file, pendingBrowse.kind);
      setPendingBrowse(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogs((entries) => [`Local import error: ${message}`, ...entries]);
    }
  }

  async function handleCanvasDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file";
    const type = `input.${kind}`;
    const item = library.find((candidate) => candidate.type === type)!;
    const id = `${type.replace(".", "_")}_${nodes.length + 1}`;
    try {
      const path = await importLocalAsset(file, kind);
      const routeNode = { id, type, title: item.label, params: { path }, ui: {} };
      setNodes((current) => [
        ...current,
        { id, type: "route", position: { x: 160 + current.length * 30, y: 120 + current.length * 24 }, data: { label: `${item.label}\n${type}`, routeNode } }
      ]);
      setLogs((entries) => [`Dropped ${kind}: ${path}`, ...entries]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogs((entries) => [`Drop import error: ${message}`, ...entries]);
    }
  }

  function updateNodeParams(nodeId: string, params: Record<string, unknown>) {
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId) return node;
        const routeNode = { ...(node.data.routeNode as RouteDoc["nodes"][number]), params };
        return { ...node, data: { ...node.data, routeNode } };
      })
    );
    if (selectedId === nodeId) setParamsText(JSON.stringify(params, null, 2));
  }

  function addNode(type: string) {
    const item = library.find((candidate) => candidate.type === type)!;
    const idBase = type.replace(".", "_");
    const id = `${idBase}_${nodes.length + 1}`;
    const routeNode = { id, type, title: item.label, params: item.params, ui: {} };
    setNodes((current) => [
      ...current,
      { id, type: "route", position: { x: 120 + current.length * 36, y: 140 + current.length * 28 }, data: { label: `${item.label}\n${type}`, routeNode } }
    ]);
  }

  function handleNodesChange(changes: NodeChange[]) {
    onNodesChange(changes);
    const selected = changes.find((change) => change.type === "select" && change.selected);
    if (selected && "id" in selected) setSelectedId(selected.id);
  }

  function handleEdgesChange(changes: EdgeChange[]) {
    onEdgesChange(changes);
  }

  function deleteSelection() {
    const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    const selectedEdgeIds = new Set(edges.filter((edge) => edge.selected).map((edge) => edge.id));

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0 && selectedId) {
      selectedNodeIds.add(selectedId);
    }

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;

    setNodes((current) => current.filter((node) => !selectedNodeIds.has(node.id)));
    setEdges((current) =>
      current.filter((edge) => !selectedEdgeIds.has(edge.id) && !selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target))
    );
    setSelectedId(null);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [`Deleted ${selectedNodeIds.size} node(s), ${selectedEdgeIds.size} edge(s).`, ...current]);
  }

  function isConnectionValid(connection: Connection | Edge): boolean {
    const sourceNode = nodes.find((node) => node.id === connection.source);
    const targetNode = nodes.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode || !connection.sourceHandle || !connection.targetHandle) return false;
    const sourceType = String((sourceNode.data.routeNode as RouteDoc["nodes"][number]).type);
    const targetType = String((targetNode.data.routeNode as RouteDoc["nodes"][number]).type);
    const sourcePort = getNodePorts(sourceType).outputs.find((port) => port.id === connection.sourceHandle);
    const targetPort = getNodePorts(targetType).inputs.find((port) => port.id === connection.targetHandle);
    if (!sourcePort || !targetPort) return false;
    return arePortsCompatible(sourcePort.kind, targetPort.kind);
  }

  function connectNodes(connection: Connection) {
    if (!isConnectionValid(connection)) {
      setLogs((current) => [`Invalid connection: ${describeConnection(connection)}`, ...current]);
      return;
    }
    setEdges((current) => addEdge(connection, current));
  }

  function selectNode(node: Node | null) {
    setSelectedId(node?.id ?? null);
    setParamsText(JSON.stringify((node?.data.routeNode as RouteDoc["nodes"][number] | undefined)?.params ?? {}, null, 2));
    setParamsError(null);
  }

  function saveParams() {
    if (!selectedId) return;
    try {
      const params = JSON.parse(paramsText);
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("Params must be a JSON object.");
      }
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== selectedId) return node;
          const routeNode = { ...(node.data.routeNode as RouteDoc["nodes"][number]), params };
          return { ...node, data: { ...node.data, routeNode } };
        })
      );
      setParamsError(null);
      setLogs((current) => [`Saved params for ${selectedId}.`, ...current]);
    } catch (error) {
      const message = `Invalid params JSON: ${error instanceof Error ? error.message : String(error)}`;
      setParamsError(message);
      setLogs((current) => [message, ...current]);
    }
  }

  async function validate() {
    const route = flowToRoute(nodes, edges, routeBase);
    const response = await fetch(`${apiBase}/api/routes/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(route) });
    const result = await response.json();
    setOutputs(result);
    setRunResult(null);
    const validationMessages = result.ok
      ? ["Validation passed."]
      : [`Validation failed with ${result.issues?.length ?? 0} issue(s).`, ...((result.issues ?? []).map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`))];
    setLogs((current) => [...validationMessages, ...current]);
  }

  async function run() {
    const route = flowToRoute(nodes, edges, routeBase);
    setRunResult({
      status: "running",
      nodeResults: Object.fromEntries(nodes.map((node) => [node.id, { status: "pending" }]))
    });
    const response = await fetch(`${apiBase}/api/routes/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(route) });
    const result = await response.json();
    setOutputs(result);
    setRunResult(result);
    const runLogs = Array.isArray(result.logs) ? result.logs.map((entry: { message: string }) => entry.message) : [result.error ?? "Run failed."];
    setLogs((current) => [...runLogs.reverse(), ...current]);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(flowToRoute(nodes, edges, routeBase), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "studio-route.route.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File | null) {
    if (!file) return;
    try {
      const route = JSON.parse(await file.text()) as RouteDoc;
      const flow = routeToFlow(route);
      setRouteBase(route);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setRunResult(null);
      setOutputs(null);
      setLogs((current) => [`Imported ${file.name}.`, ...current]);
    } catch (error) {
      setLogs((current) => [`Import failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function loadExample() {
    const flow = routeToFlow(exampleRoute);
    setRouteBase(exampleRoute);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => ["Loaded debug example.", ...current]);
  }

  return (
    <div className={`app ${leftCollapsed ? "leftCollapsed" : ""} ${rightCollapsed ? "rightCollapsed" : ""}`}>
      <aside className="sidebar left">
        <div className="sidebarHeader">
          {!leftCollapsed ? <h1>SnarkRoute</h1> : null}
          <button className="iconButton" title={leftCollapsed ? "Expand left panel" : "Collapse left panel"} onClick={() => setLeftCollapsed((value) => !value)}>
            {leftCollapsed ? <ChevronRight size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        {!leftCollapsed ? (
        <>
        <div className="toolbar">
          <button onClick={loadExample} title="Load example"><Wand2 size={16} /> Example</button>
          <button onClick={exportJson} title="Export route JSON"><Download size={16} /> Export</button>
          <label className="fileButton" title="Import route JSON"><Upload size={16} /> Import<input type="file" accept=".json,.route.json,application/json" onChange={(event) => void importJson(event.target.files?.[0] ?? null)} /></label>
        </div>
        <h2>Nodes</h2>
        <div className="portLegend">
          <span><i className="legendDot text" />Text</span>
          <span><i className="legendDot image" />Image</span>
          <span><i className="legendDot video" />Video</span>
          <span><i className="legendDot file" />File</span>
        </div>
        {library.map((item) => (
          <button key={item.type} className="libraryItem" onClick={() => addNode(item.type)}><Plus size={16} />{item.label}<span>{item.type}</span></button>
        ))}
        </>
        ) : null}
      </aside>

      <main className="canvas" onDragOver={(event) => event.preventDefault()} onDrop={handleCanvasDrop}>
        <div className="topbar">
          <button onClick={validate}><FileJson size={16} /> Validate</button>
          <button className="primary" onClick={() => void run()}><Play size={16} /> Run</button>
          <button className="danger" onClick={deleteSelection} disabled={selectedNodeCount === 0 && selectedEdgeCount === 0 && !selectedId}><Trash2 size={16} /> Delete</button>
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={connectNodes}
          isValidConnection={isConnectionValid}
          onNodeClick={(_event, node) => selectNode(node)}
          onEdgeClick={() => setSelectedId(null)}
          onPaneClick={() => selectNode(null)}
          onKeyDown={(event) => {
            if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
          }}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          selectionOnDrag
          panOnDrag={[1, 2]}
          deleteKeyCode={["Delete", "Backspace"]}
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background />
        </ReactFlow>
        <input
          id="asset-file-picker"
          className="hiddenFileInput"
          type="file"
          accept={pendingBrowse?.kind === "image" ? "image/png,image/jpeg,image/webp" : pendingBrowse?.kind === "video" ? "video/*" : undefined}
          onChange={(event) => {
            void handleFallbackFile(event.target.files?.[0] ?? null);
            event.currentTarget.value = "";
          }}
        />
      </main>

      <aside className="sidebar right">
        <div className="sidebarHeader">
          {!rightCollapsed ? <h2>Settings</h2> : null}
          <button className="iconButton" title={rightCollapsed ? "Expand right panel" : "Collapse right panel"} onClick={() => setRightCollapsed((value) => !value)}>
            {rightCollapsed ? <ChevronLeft size={17} /> : <PanelRightClose size={17} />}
          </button>
        </div>
        {!rightCollapsed ? (
        <>
        <div className="settingsPanel">
          <div className={`settingsStatus ${replicateConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            {replicateConfigured ? "Replicate configured" : "Replicate not configured"}
          </div>
          <label className="settingsField">
            <span>REPLICATE_API_TOKEN</span>
            <input
              type="password"
              value={replicateToken}
              placeholder="Paste token"
              onChange={(event) => setReplicateToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button onClick={() => void saveReplicateToken()}><Save size={16} /> Save Token</button>
          {settingsMessage ? <p className={settingsMessage.includes("error") || settingsMessage.includes("Failed") || settingsMessage.includes("empty") ? "errorText" : "muted"}>{settingsMessage}</p> : null}
        </div>

        <h2>Inspector</h2>
        <p className="selectionHint">{selectedNodeCount} node(s), {selectedEdgeCount} edge(s) selected</p>
        {selectedNode ? (
          <>
            <p className="muted">{selectedNode.id}</p>
            <textarea value={paramsText} onChange={(event) => setParamsText(event.target.value)} />
            {paramsError ? <p className="errorText">{paramsError}</p> : null}
            <button onClick={saveParams}>Save Params</button>
          </>
        ) : (
          <p className="muted">Select a node.</p>
        )}
        </>
        ) : null}
      </aside>

      <section className="bottom">
        <div>
          <h2>Logs</h2>
          <pre>{formatLogs(runResult, logs)}</pre>
        </div>
        <div>
          <h2>Outputs</h2>
          <pre>{outputs ? formatOutputs(outputs) : "No outputs yet."}</pre>
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function formatLogs(runResult: RunDisplayResult | null, fallbackLogs: string[]): string {
  const header = runResult?.runId
    ? [`runId: ${runResult.runId}`, `status: ${runResult.status ?? "unknown"}`, `startedAt: ${runResult.startedAt ?? ""}`, `completedAt: ${runResult.completedAt ?? ""}`, ""]
    : [];
  const runLogs = runResult?.logs?.map((entry) => `${entry.timestamp ?? ""}${entry.nodeId ? ` [${entry.nodeId}]` : ""} ${entry.message}`) ?? fallbackLogs;
  return [...header, ...runLogs].join("\n");
}

function formatOutputs(outputs: unknown): string {
  return JSON.stringify(outputs, null, 2);
}

async function importLocalAsset(file: File, kind: AssetKind): Promise<string> {
  const dataBase64 = await fileToBase64(file);
  const response = await fetch(`${apiBase}/api/assets/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, dataBase64, kind })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Local import failed.");
  if (!result.path) throw new Error("Local import did not return a path.");
  return result.path;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      resolve(text.includes(",") ? text.split(",")[1] : text);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}
