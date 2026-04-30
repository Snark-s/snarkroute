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
  type Node,
  type NodeProps
} from "@xyflow/react";
import { Download, FileJson, Play, Plus, Upload, Wand2 } from "lucide-react";
import React, { useMemo, useState } from "react";
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

const apiBase = "";

const library = [
  { type: "input.text", label: "Text Input", params: { value: "A small route prompt" } },
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

  function patchParams(patch: Record<string, unknown>) {
    onParamsChange?.(id, { ...params, ...patch });
  }

  return (
    <div className="routeNodeCard">
      <span className={`nodeStatus ${statusClass(result?.status)}`} />
      <Handle type="target" position={Position.Left} />
      <div className="nodeTitle">{title}</div>
      <div className="nodeType">{type}</div>
      <NodeInlineParams type={type} params={params} onChange={patchParams} />
      {result ? <NodeInlineResult result={result} /> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function NodeInlineParams({
  type,
  params,
  onChange
}: {
  type: string;
  params: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
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

  const selectedNode = nodes.find((node) => node.id === selectedId);
  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onParamsChange: updateNodeParams,
          result: runResult?.nodeResults?.[node.id]
        }
      })),
    [nodes, runResult]
  );

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
    <div className="app">
      <aside className="sidebar left">
        <h1>SnarkRoute</h1>
        <div className="toolbar">
          <button onClick={loadExample} title="Load example"><Wand2 size={16} /> Example</button>
          <button onClick={exportJson} title="Export route JSON"><Download size={16} /> Export</button>
          <label className="fileButton" title="Import route JSON"><Upload size={16} /> Import<input type="file" accept=".json,.route.json,application/json" onChange={(event) => void importJson(event.target.files?.[0] ?? null)} /></label>
        </div>
        <h2>Nodes</h2>
        {library.map((item) => (
          <button key={item.type} className="libraryItem" onClick={() => addNode(item.type)}><Plus size={16} />{item.label}<span>{item.type}</span></button>
        ))}
      </aside>

      <main className="canvas">
        <div className="topbar">
          <button onClick={validate}><FileJson size={16} /> Validate</button>
          <button className="primary" onClick={() => void run()}><Play size={16} /> Run</button>
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection: Connection) => setEdges((current) => addEdge(connection, current))}
          onNodeClick={(_event, node) => selectNode(node)}
          onPaneClick={() => selectNode(null)}
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background />
        </ReactFlow>
      </main>

      <aside className="sidebar right">
        <h2>Inspector</h2>
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
