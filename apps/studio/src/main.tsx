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
  type NodeProps,
  type ReactFlowInstance
} from "@xyflow/react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, FileJson, KeyRound, PanelLeftClose, PanelRightClose, Play, Plus, Save, Trash2, Upload, Wand2 } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type RouteDoc = {
  routeVersion: string;
  route: { id: string; title: string; description?: string; author: Record<string, unknown>; tags?: string[] };
  economics?: Record<string, unknown>;
  nodes: Array<{ id: string; type: string; title?: string; params?: Record<string, unknown>; ui?: Record<string, unknown> }>;
  edges: Array<{ id?: string; from: string; to: string; fromPort?: string; toPort?: string }>;
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
  economics?: unknown;
  error?: string;
};

type LedgerSummary = {
  totalRuns: number;
  runsByProvider: Record<string, number>;
  runsByStatus: Record<string, number>;
  estimatedProviderCostTotal: number | null;
  actualProviderCostTotal: number | null;
  paymentExecuted: false;
  paymentExecutedCount: number;
  recentRuns: Array<Record<string, unknown>>;
};

type AssetKind = "file" | "image" | "video";

const apiBase = "";
const NODE_DRAG_MIME = "application/x-snarkroute-node";

const library = [
  { type: "input.text", label: "Text Input", params: { value: "A small route prompt" } },
  { type: "input.file", label: "Input File", params: { path: "" } },
  { type: "input.image", label: "Input Image", params: { path: "" } },
  { type: "input.video", label: "Input Video", params: { path: "" } },
  {
    type: "replicate.clarity-upscaler",
    label: "Clarity Upscaler",
    params: {
      prompt: "masterpiece, best quality, highres",
      negative_prompt: "(worst quality, low quality, normal quality:2)",
      scale_factor: 2,
      dynamic: 6,
      creativity: 0.35,
      resemblance: 0.6,
      tiling_width: 112,
      tiling_height: 144,
      scheduler: "DPM++ 3M SDE Karras",
      num_inference_steps: 18,
      seed: 1337,
      downscaling: false,
      downscaling_resolution: 768,
      lora_links: "",
      pollingIntervalMs: 1000,
      timeoutMs: 120000
    }
  },
  { type: "preview.image", label: "Image Preview", params: { title: "Preview" } },
  { type: "transform.template", label: "Template Transform", params: { template: "{{input_prompt.output.text}}" } },
  { type: "replicate.model", label: "Replicate Model", params: { model: "black-forest-labs/flux-schnell", input: { prompt: "{{input_prompt.output.text}}" } } },
  { type: "debug.log", label: "Debug Log", params: { message: "Debug value", value: "{{input_prompt.output.text}}" } },
  { type: "output.text", label: "Text Output", params: {} },
  { type: "output.file", label: "Save Text File", params: { filename: "output.txt", from: "{{output_text.output.text}}" } }
];

const librarySections = [
  { id: "inputs", title: "Input", types: ["input.text", "input.file", "input.image", "input.video"] },
  { id: "image", title: "Image Processing", types: ["replicate.clarity-upscaler", "preview.image"] },
  { id: "models", title: "Models / Providers", types: ["replicate.model"] },
  { id: "transforms", title: "Transforms", types: ["transform.template"] },
  { id: "outputs", title: "Output", types: ["output.text", "output.file"] },
  { id: "debug", title: "Debug", types: ["debug.log"] }
];

const exampleRoute: RouteDoc = {
  routeVersion: "0.1",
  route: { id: "clarity-upscale-basic", title: "Clarity Upscale Basic", author: { name: "SnarkRoute" }, tags: ["replicate", "image", "upscale"] },
  economics: {
    enabled: false,
    mode: "disabled",
    currency: "USD",
    providerCosts: [{ provider: "replicate", model: "philz1337x/clarity-upscaler", nodeType: "replicate.clarity-upscaler", pricingHint: "external-provider-billing", estimatedCost: null, actualCost: null }],
    notes: "Economics metadata is preserved. No payment execution in v0.1."
  },
  nodes: [
    { id: "input_image", type: "input.image", title: "Input Image", params: { path: "" }, ui: { x: 80, y: 80 } },
    {
      id: "upscale",
      type: "replicate.clarity-upscaler",
      title: "Clarity Upscaler",
      params: {
        prompt: "masterpiece, best quality, highres",
        negative_prompt: "(worst quality, low quality, normal quality:2)",
        scale_factor: 2,
        dynamic: 6,
        creativity: "0,25",
        resemblance: "1,5",
        tiling_width: 112,
        tiling_height: 144,
        scheduler: "DPM++ 3M SDE Karras",
        num_inference_steps: 18,
        seed: 1337,
        downscaling: false,
        downscaling_resolution: 768,
        lora_links: "",
        pollingIntervalMs: 1000,
        timeoutMs: 120000
      },
      ui: { x: 470, y: 80 }
    }
  ],
  edges: [{ from: "input_image", to: "upscale", fromPort: "image", toPort: "image" }],
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
        <React.Fragment key={port.id}>
          <span className="portLabel input" style={{ top: `${34 + index * 28}px` }}>
            {port.id}
          </span>
          <Handle
            className={`typedHandle ${port.kind}`}
            id={port.id}
            type="target"
            position={Position.Left}
            style={{ top: `${42 + index * 28}px` }}
            title={`${port.id}: ${port.kind}`}
          />
        </React.Fragment>
      ))}
      <div className="nodeTitle">{title}</div>
      <div className="nodeType">{type}</div>
      <NodeInlineParams type={type} params={params} onChange={patchParams} onBrowse={(kind) => onBrowseAsset?.(id, kind)} />
      {result ? <NodeInlineResult result={result} /> : null}
      {ports.outputs.map((port, index) => (
        <React.Fragment key={port.id}>
          <span className="portLabel output" style={{ top: `${34 + index * 28}px` }}>
            {port.id}
          </span>
          <Handle
            className={`typedHandle ${port.kind}`}
            id={port.id}
            type="source"
            position={Position.Right}
            style={{ top: `${42 + index * 28}px` }}
            title={`${port.id}: ${port.kind}`}
          />
        </React.Fragment>
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

  if (type === "replicate.clarity-upscaler") {
    return (
      <>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.prompt ?? "")} onChange={(event) => onChange({ prompt: event.target.value })} />
        </label>
        <label className="nodeField">
          <span>negative</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={String(params.negative_prompt ?? "")} onChange={(event) => onChange({ negative_prompt: event.target.value })} />
        </label>
        <div className="nodeGridFields">
          {(["scale_factor", "dynamic", "creativity", "resemblance", "num_inference_steps", "seed"] as const).map((key) => (
            <label className="nodeField" key={key}>
              <span>{key}</span>
              <input
                className="nodrag nopan nodeInput"
                inputMode="decimal"
                value={String(params[key] ?? "").replace(".", ",")}
                onChange={(event) => onChange({ [key]: event.target.value.replace(".", ",") })}
              />
            </label>
          ))}
        </div>
      </>
    );
  }

  if (type === "preview.image") {
    return (
      <label className="nodeField">
        <span>title</span>
        <input className="nodrag nopan nodeInput" value={String(params.title ?? "Preview")} onChange={(event) => onChange({ title: event.target.value })} />
      </label>
    );
  }

  if (type === "output.text") {
    return <div className="nodeHint">Text output</div>;
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
  const imageSrc = imagePreviewSrc(result.output);
  const cost = costLabel(result.output);
  const statusText = result.status && result.status !== "succeeded" ? result.status : null;
  if (imageSrc) {
    return (
      <div className={`nodeResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
        {statusText ? <div>{statusText}</div> : null}
        {cost ? <span className="nodeCost">{cost}</span> : null}
        <a className="nodeDownloadButton nodrag nopan" href={imageSrc} download={downloadFilename(result.output)} title="Download image">
          <Download size={14} />
        </a>
        <img className="nodeImagePreview" src={imageSrc} alt="" />
        <pre>{truncateText(imageLabel(result.output), 220)}</pre>
      </div>
    );
  }
  const textOutput = result.status !== "failed" ? outputText(result.output) : null;
  const preview = truncateText(result.error ?? JSON.stringify(result.output ?? {}, null, 2), 420);
  return (
    <div className={`nodeResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
      {statusText ? <div>{statusText}</div> : null}
      {cost ? <span className="nodeCost">{cost}</span> : null}
      {textOutput !== null ? <textarea className="nodrag nopan nodeTextarea outputTextArea" readOnly value={textOutput} /> : <pre>{preview}</pre>}
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

type PortKind = "text" | "image" | "video" | "file" | "json" | "data";

type PortSpec = {
  id: string;
  kind: PortKind;
};

function getNodePorts(type: string): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (type === "input.text") return { inputs: [], outputs: [{ id: "text", kind: "text" }] };
  if (type === "input.file") return { inputs: [], outputs: [{ id: "file", kind: "file" }] };
  if (type === "input.image") return { inputs: [], outputs: [{ id: "image", kind: "image" }] };
  if (type === "input.video") return { inputs: [], outputs: [{ id: "video", kind: "video" }] };
  if (type === "replicate.clarity-upscaler") {
    return {
      inputs: [{ id: "image", kind: "image" }],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json" }
      ]
    };
  }
  if (type === "preview.image") return { inputs: [{ id: "image", kind: "image" }], outputs: [{ id: "image", kind: "image" }] };
  if (type === "replicate.model") return { inputs: [{ id: "input", kind: "json" }], outputs: [{ id: "output", kind: "json" }] };
  if (type === "output.text") return { inputs: [{ id: "from", kind: "json" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "output.file") return { inputs: [{ id: "from", kind: "text" }], outputs: [] };
  if (type === "transform.template") return { inputs: [{ id: "template", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "debug.log") return { inputs: [{ id: "value", kind: "json" }], outputs: [{ id: "value", kind: "json" }] };
  return { inputs: [{ id: "input", kind: "json" }], outputs: [{ id: "output", kind: "json" }] };
}

function arePortsCompatible(source: PortKind, target: PortKind): boolean {
  if (source === "data" || target === "data") return true;
  if (source === "json" && target === "text") return true;
  if (source === "text" && target === "json") return true;
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
    edges: route.edges.map((edge, index) => ({
      id: edge.id ?? `${edge.from}-${edge.fromPort ?? "output"}-${edge.to}-${edge.toPort ?? "input"}-${index}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.fromPort,
      targetHandle: edge.toPort
    }))
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
    edges: edges.map((edge) => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      fromPort: edge.sourceHandle ?? undefined,
      toPort: edge.targetHandle ?? undefined
    })),
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
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [bottomCollapsed, setBottomCollapsed] = useState(true);
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [collapsedLibrarySections, setCollapsedLibrarySections] = useState<Record<string, boolean>>({});

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
    void loadLedgerSummary();
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

  async function loadLedgerSummary() {
    try {
      const response = await fetch(`${apiBase}/api/ledger/summary`);
      if (!response.ok) throw new Error("Ledger API unavailable.");
      setLedgerSummary(await response.json());
    } catch {
      setLedgerSummary(null);
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
    const draggedNodeType = event.dataTransfer.getData(NODE_DRAG_MIME);
    if (draggedNodeType) {
      addNode(draggedNodeType, flowPositionFromEvent(event));
      return;
    }

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

  function flowPositionFromEvent(event: React.DragEvent<HTMLElement>) {
    return reactFlowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 160 + nodes.length * 30, y: 120 + nodes.length * 24 };
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

  function addNode(type: string, position?: { x: number; y: number }) {
    const item = library.find((candidate) => candidate.type === type)!;
    const idBase = type.replace(".", "_");
    const id = `${idBase}_${nodes.length + 1}`;
    const params = structuredClone(item.params ?? {});
    const routeNode = { id, type, title: item.label, params, ui: {} };
    setNodes((current) => [
      ...current,
      { id, type: "route", position: position ?? { x: 120 + current.length * 36, y: 140 + current.length * 28 }, data: { label: `${item.label}\n${type}`, routeNode } }
    ]);
  }

  function toggleLibrarySection(id: string) {
    setCollapsedLibrarySections((current) => ({ ...current, [id]: !current[id] }));
  }

  function renderLibraryItem(item: (typeof library)[number]) {
    return (
      <button
        key={item.type}
        className="libraryItem"
        draggable
        onClick={() => addNode(item.type)}
        onDragStart={(event) => {
          event.dataTransfer.setData(NODE_DRAG_MIME, item.type);
          event.dataTransfer.effectAllowed = "copy";
        }}
      >
        <Plus size={13} />{item.label}<span>{item.type}</span>
      </button>
    );
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
    void loadLedgerSummary();
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
    setLogs((current) => ["Loaded Clarity example.", ...current]);
  }

  return (
    <div className={`app ${leftCollapsed ? "leftCollapsed" : ""} ${rightCollapsed ? "rightCollapsed" : ""} ${bottomCollapsed ? "bottomCollapsed" : ""}`}>
      <aside className="sidebar left">
        <div className="sidebarHeader">
          {!leftCollapsed ? <h1><img src="/snarkroute-icon.png" alt="" />SnarkRoute</h1> : null}
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
          <span><i className="legendDot json" />JSON</span>
          <span><i className="legendDot video" />Video</span>
          <span><i className="legendDot file" />File</span>
        </div>
        <div className="librarySections">
          {librarySections.map((section) => {
            const collapsed = Boolean(collapsedLibrarySections[section.id]);
            const items = section.types.map((type) => library.find((item) => item.type === type)).filter((item): item is (typeof library)[number] => Boolean(item));
            return (
              <section className="librarySection" key={section.id}>
                <button className="librarySectionHeader" onClick={() => toggleLibrarySection(section.id)}>
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span>{section.title}</span>
                  <small>{items.length}</small>
                </button>
                {!collapsed ? <div className="librarySectionItems">{items.map(renderLibraryItem)}</div> : null}
              </section>
            );
          })}
        </div>
        </>
        ) : null}
      </aside>

      <main
        className="canvas"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = event.dataTransfer.types.includes(NODE_DRAG_MIME) || event.dataTransfer.types.includes("Files") ? "copy" : "none";
        }}
        onDrop={handleCanvasDrop}
      >
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
          onInit={setReactFlowInstance}
          isValidConnection={isConnectionValid}
          onNodeClick={(_event, node) => selectNode(node)}
          onEdgeClick={() => setSelectedId(null)}
          onPaneClick={() => selectNode(null)}
          onKeyDown={(event) => {
            if ((event.key === "Delete" || event.key === "Backspace") && !isTextEditingTarget(event.target)) {
              deleteSelection();
            }
          }}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          selectionOnDrag
          panOnDrag={[1, 2]}
          deleteKeyCode={null}
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

        <h2>Economics</h2>
        <EconomicsPanel route={flowToRoute(nodes, edges, routeBase)} runResult={runResult} ledgerSummary={ledgerSummary} />
        </>
        ) : null}
      </aside>

      <section className="bottom">
        <div className="bottomHeader">
          <button className="iconButton" title={bottomCollapsed ? "Expand bottom panel" : "Collapse bottom panel"} onClick={() => setBottomCollapsed((value) => !value)}>
            {bottomCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </button>
          <span>Logs / Outputs</span>
        </div>
        {!bottomCollapsed ? (
        <>
        <div>
          <h2>Logs</h2>
          <pre>{formatLogs(runResult, logs)}</pre>
        </div>
        <div>
          <h2>Outputs</h2>
          <pre>{outputs ? formatOutputs(outputs) : "No outputs yet."}</pre>
        </div>
        </>
        ) : null}
      </section>
    </div>
  );
}

function EconomicsPanel({ route, runResult, ledgerSummary }: { route: RouteDoc; runResult: RunDisplayResult | null; ledgerSummary: LedgerSummary | null }) {
  const economics = route.economics ?? { enabled: false, mode: "disabled" };
  const runEconomics = runResult?.economics && typeof runResult.economics === "object" ? (runResult.economics as Record<string, unknown>) : null;
  const providersUsed = Array.isArray(runEconomics?.providersUsed) ? runEconomics.providersUsed : [];
  return (
    <div className="economicsPanel">
      <div className="economicsGrid">
        <span>enabled</span>
        <strong>{String(economics.enabled ?? false)}</strong>
        <span>mode</span>
        <strong>{String(economics.mode ?? (economics.enabled ? "metadata-only" : "disabled"))}</strong>
        <span>payment</span>
        <strong>false</strong>
      </div>
      <pre className="miniPre">
        {JSON.stringify(
          {
            author: economics.author ?? route.route.author,
            contributors: economics.contributors ?? [],
            revenueSplits: economics.revenueSplits ?? []
          },
          null,
          2
        )}
      </pre>
      <h3>Last Run</h3>
      {runEconomics ? (
        <pre className="miniPre">
          {JSON.stringify(
            {
              providersUsed,
              costSummary: runEconomics.costSummary,
              paymentExecuted: false
            },
            null,
            2
          )}
        </pre>
      ) : (
        <p className="muted">No run accounting yet.</p>
      )}
      <h3>Ledger</h3>
      {ledgerSummary ? (
        <pre className="miniPre">
          {JSON.stringify(
            {
              totalRuns: ledgerSummary.totalRuns,
              runsByProvider: ledgerSummary.runsByProvider,
              runsByStatus: ledgerSummary.runsByStatus,
              estimatedProviderCostTotal: ledgerSummary.estimatedProviderCostTotal,
              actualProviderCostTotal: ledgerSummary.actualProviderCostTotal,
              recentRuns: ledgerSummary.recentRuns.slice(0, 3)
            },
            null,
            2
          )}
        </pre>
      ) : (
        <p className="muted">Ledger unavailable.</p>
      )}
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
  const cost = runCostLabel(outputs);
  const body = JSON.stringify(outputs, null, 2);
  return cost ? `${cost}\n\n${body}` : body;
}

function imagePreviewSrc(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return imagePreviewSrc(value[0]);
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return value;
    if (/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) return `${apiBase}/api/assets/preview?path=${encodeURIComponent(value)}`;
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return imagePreviewSrc(record.image ?? record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.output);
  }
  return null;
}

function imageLabel(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const image = (record.image && typeof record.image === "object" ? record.image : record) as Record<string, unknown>;
    return String(image.filename ?? image.localPath ?? image.path ?? image.originalUrl ?? "image");
  }
  return String(value ?? "image");
}

function outputText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}

function downloadFilename(value: unknown): string {
  const label = imageLabel(value).split(/[\\/]/).pop() ?? "snarkroute-image.png";
  return label || "snarkroute-image.png";
}

function costLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const output = value as Record<string, unknown>;
  const cost = output.cost;
  const record = cost && typeof cost === "object" ? (cost as Record<string, unknown>) : null;
  const metrics = output.metrics && typeof output.metrics === "object" ? (output.metrics as Record<string, unknown>) : null;
  const seconds = Number(record?.seconds ?? metrics?.predict_time ?? metrics?.total_time);
  const estimatedUsdFromCost = Number(record?.estimatedUsd ?? record?.amountUsd);
  const estimatedUsd = Number.isFinite(estimatedUsdFromCost) ? estimatedUsdFromCost : Number.isFinite(seconds) ? seconds * 0.0014 : NaN;
  if (!Number.isFinite(estimatedUsd)) return null;
  const parts = [`Estimated cost for this image: $${estimatedUsd.toFixed(4)}`];
  if (Number.isFinite(seconds)) parts.push(`${seconds.toFixed(2)}s`);
  return parts.join(" · ");
}

function runCostLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nodeResults = record.nodeResults;
  if (!nodeResults || typeof nodeResults !== "object") return null;
  const labels = Object.entries(nodeResults as Record<string, unknown>)
    .map(([nodeId, result]) => {
      if (!result || typeof result !== "object") return null;
      const output = (result as Record<string, unknown>).output;
      const label = costLabel(output);
      return label ? `${nodeId}: ${label}` : null;
    })
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join("\n") : null;
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

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}
