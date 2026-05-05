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
import { exportRouteToText, loadRouteFromText, normalizeRouteExportFilename, type OpenRoute } from "@snarkroute/protocol";
import { Braces, Bug, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Eye, FileJson, FileText, FolderOpen, ImageIcon, KeyRound, PanelLeftClose, PanelRightClose, Play, Plus, Save, Sparkles, Trash2, Type, Upload, Video, Wand2, X } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { geminiTokenStatusText, localApiUnavailableMessage, replicateTokenStatusText } from "./security-ui";

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

const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";
const NODE_DRAG_MIME = "application/x-snarkroute-node";
const ROUTE_FILE_ACCEPT = ".orp,.opt,.orp.json,.opt.json,.orp.yaml,.opt.yaml,.orp.yml,.opt.yml,.route,.route.json,.route.yaml,.route.yml,.json,.yaml,.yml,application/json,application/yaml,text/yaml,text/x-yaml";
const SAVED_PROJECT_STORAGE_KEY = "snarkroute-studio:saved-project";
const GEMINI_API_KEY_URL = "https://aistudio.google.com/app/apikey";
const GEMINI_LLM_DEFAULT_SYSTEM_PROMPT = `Convert the user's rough idea into a clean image-generation prompt.
Preserve the humor and core idea.
Make risky wording safe and non-erotic.
Do not include copyrighted characters, logos, or text.
Output only the final image prompt.`;
const GEMINI_LLM_MODEL_OPTIONS = [
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.4 },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", inputUsdPerMillionTokens: 0.3, outputUsdPerMillionTokens: 2.5 },
  { value: "gemini-2.5-flash-preview-09-2025", label: "Gemini 2.5 Flash Preview", inputUsdPerMillionTokens: 0.3, outputUsdPerMillionTokens: 2.5 },
  { value: "gemini-2.5-flash-lite-preview-09-2025", label: "Gemini 2.5 Flash-Lite Preview", inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.4 }
];

const library = [
  { type: "input.text", label: "Text Input", params: { value: "A small route prompt" } },
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
  {
    type: "gemini.nano-banana-2",
    label: "Nano Banana 2",
    params: {
      prompt: "Transform this into a polished, high-detail image.",
      aspectRatio: "1:1",
      imageSize: "2K"
    }
  },
  {
    type: "gemini.llm",
    label: "Gemini LLM",
    params: {
      systemPrompt: GEMINI_LLM_DEFAULT_SYSTEM_PROMPT,
      prompt: "",
      model: "gemini-2.5-flash-lite"
    }
  },
  { type: "preview.image", label: "Image Preview", params: { title: "Preview" } },
  { type: "debug.log", label: "Debug Log", params: { message: "Debug value", value: "{{input_prompt.output.text}}" } },
  { type: "output.text", label: "Text Output", params: {} },
  { type: "output.file", label: "Save Text File", params: { filename: "output.txt", from: "{{output_text.output.text}}" } }
];

const librarySections = [
  { id: "inputs", title: "Input", types: ["input.text", "input.image", "input.video"] },
  { id: "image", title: "Image Processing", types: ["replicate.clarity-upscaler", "gemini.nano-banana-2", "preview.image"] },
  { id: "text", title: "Text Generation", types: ["gemini.llm"] },
  { id: "outputs", title: "Output", types: ["output.text", "output.file"] },
  { id: "debug", title: "Debug", types: ["debug.log"] }
];

const blankRoute: RouteDoc = {
  routeVersion: "0.1",
  route: { id: "blank-route", title: "Blank Route", author: { name: "SnarkRoute" } },
  economics: { enabled: false, mode: "disabled" },
  nodes: [],
  edges: [],
  provenance: { tool: "snarkroute-studio" }
};

const exampleRoute: RouteDoc = {
  routeVersion: "0.1",
  route: { id: "gemini-prompt-to-image", title: "Gemini Prompt to Image", author: { name: "SnarkRoute" }, tags: ["gemini", "llm", "image"] },
  economics: {
    enabled: false,
    mode: "disabled",
    currency: "USD",
    providerCosts: [
      { provider: "gemini", model: "gemini-2.5-flash-lite", nodeType: "gemini.llm", pricingHint: "external-provider-billing", estimatedCost: null, actualCost: null },
      { provider: "gemini", model: "gemini-3.1-flash-image-preview", nodeType: "gemini.nano-banana-2", pricingHint: "external-provider-billing", estimatedCost: null, actualCost: null }
    ],
    notes: "Economics metadata is preserved. No payment execution in v0.1."
  },
  nodes: [
    {
      id: "input_prompt",
      type: "input.text",
      title: "Text Input",
      params: { value: "А мы сделаем свой нодовый редактор с преферансом и куртизанками" },
      ui: { x: 80, y: 160 }
    },
    {
      id: "gemini_llm",
      type: "gemini.llm",
      title: "Gemini LLM",
      params: {
        systemPrompt: GEMINI_LLM_DEFAULT_SYSTEM_PROMPT,
        prompt: "",
        model: "gemini-2.5-flash-lite"
      },
      ui: { x: 440, y: 80 }
    },
    {
      id: "gemini_nano-banana-2",
      type: "gemini.nano-banana-2",
      title: "Nano Banana 2",
      params: {
        prompt: "Transform this into a polished, high-detail image.",
        aspectRatio: "16:9",
        imageSize: "1K"
      },
      ui: { x: 820, y: 80 }
    }
  ],
  edges: [
    { from: "input_prompt", to: "gemini_llm", fromPort: "text", toPort: "prompt" },
    { from: "gemini_llm", to: "gemini_nano-banana-2", fromPort: "text", toPort: "prompt" }
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
  const replicateConfigured = Boolean(data.replicateConfigured);
  const geminiConfigured = Boolean(data.geminiConfigured);
  const onConfigureReplicate = data.onConfigureReplicate as (() => void) | undefined;
  const onConfigureGemini = data.onConfigureGemini as (() => void) | undefined;
  const onOpenImage = data.onOpenImage as ((image: ImageViewerState) => void) | undefined;
  const onRunNodeOnly = data.onRunNodeOnly as ((nodeId: string) => void) | undefined;
  const onRunNodeWithDependencies = data.onRunNodeWithDependencies as ((nodeId: string) => void) | undefined;
  const connectedInputPorts = new Set((data.connectedInputPorts as string[] | undefined) ?? []);
  const inputConnectionCounts = (data.inputConnectionCounts as Record<string, number> | undefined) ?? {};
  const canRunNodeOnly = Boolean(data.canRunNodeOnly);
  const ports = getNodePorts(type);

  function patchParams(patch: Record<string, unknown>) {
    onParamsChange?.(id, { ...params, ...patch });
  }

  return (
    <div className="routeNodeCard">
      <span className={`nodeStatus ${statusClass(result?.status)}`} />
      {shouldShowNodeRunButton(type) ? (
        <div className="nodeRunActions">
          <button
            className="nodeRunButton nodrag nopan"
            type="button"
            title={canRunNodeOnly ? "Run this node only" : "Run this node only after all inputs have ready outputs"}
            disabled={!canRunNodeOnly}
            onClick={(event) => {
              event.stopPropagation();
              onRunNodeOnly?.(id);
            }}
          >
            <Play size={12} />
          </button>
          <button
            className="nodeRunButton dependency nodrag nopan"
            type="button"
            title="Run this node with upstream dependencies"
            onClick={(event) => {
              event.stopPropagation();
              onRunNodeWithDependencies?.(id);
            }}
          >
            <span className="nodeRunDoubleArrow">&gt;&gt;</span>
          </button>
        </div>
      ) : null}
      {ports.inputs.map((port, index) => (
        <React.Fragment key={port.id}>
          <span className="portLabel input" style={{ top: `${34 + index * 28}px` }}>
            {port.maxConnections ? `${port.label ?? port.id} (${inputConnectionCounts[port.id] ?? 0}/${port.maxConnections})` : port.label ?? port.id}
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
      <div className="nodeHeader">
        <span className={`nodeIcon ${nodeIconClass(type)}`}>{nodeIcon(type)}</span>
        <div>
          <div className="nodeTitle">{title}</div>
          <div className="nodeType" title={type}>{type}</div>
        </div>
      </div>
      {isReplicateNode(type) ? (
        <div className={`nodeTokenStatus ${replicateConfigured ? "configured" : "missing"}`}>
          <span>{replicateTokenStatusText(replicateConfigured)}</span>
          {!replicateConfigured ? (
            <>
              <strong>Requires Replicate API token</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureReplicate}>Configure Replicate</button>
              <small>Open Settings \u2192 Secrets \u2192 Replicate</small>
            </>
          ) : null}
        </div>
      ) : null}
      {isGeminiNode(type) ? (
        <div className={`nodeTokenStatus ${geminiConfigured ? "configured" : "missing"}`}>
          <span>{geminiTokenStatusText(geminiConfigured)}</span>
          {!geminiConfigured ? (
            <>
              <strong>Requires Gemini API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureGemini}>Configure Gemini</button>
              <small>Open Settings \u2192 Secrets \u2192 Gemini</small>
              <a className="nodeTokenLink nodrag nopan" href={GEMINI_API_KEY_URL} target="_blank" rel="noreferrer">Get Gemini API key</a>
            </>
          ) : null}
        </div>
      ) : null}
      <NodeInlineParams
        type={type}
        params={params}
        connectedInputPorts={connectedInputPorts}
        onChange={patchParams}
        onBrowse={(kind) => onBrowseAsset?.(id, kind)}
      />
      {result && shouldShowInlineResult(type) ? <NodeInlineResult result={result} onOpenImage={onOpenImage} /> : null}
      {ports.outputs.map((port, index) => (
        <React.Fragment key={port.id}>
          <span className="portLabel output" style={{ top: `${34 + index * 28}px` }}>
            {port.label ?? port.id}
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
  connectedInputPorts,
  onChange,
  onBrowse
}: {
  type: string;
  params: Record<string, unknown>;
  connectedInputPorts: Set<string>;
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
          <span>file</span>
          <input
            className="nodrag nopan nodeInput"
            value={path ? filenameFromPath(path) : ""}
            placeholder="No file selected"
            title={path}
            readOnly
          />
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
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => onChange({ prompt: event.target.value })}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
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

  if (type === "gemini.nano-banana-2") {
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => onChange({ prompt: event.target.value })}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>aspect ratio</span>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.aspectRatio ?? "1:1")}
              onChange={(event) => onChange({ aspectRatio: event.target.value })}
            >
              {["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="nodeField">
            <span>quality</span>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.imageSize ?? "2K")}
              onChange={(event) => onChange({ imageSize: event.target.value })}
            >
              {["1K", "2K", "4K"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </>
    );
  }

  if (type === "gemini.llm") {
    const systemPromptConnected = connectedInputPorts.has("systemPrompt");
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <label className="nodeField">
          <span>system prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${systemPromptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.systemPrompt ?? GEMINI_LLM_DEFAULT_SYSTEM_PROMPT)}
            disabled={systemPromptConnected}
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
          />
          {systemPromptConnected ? <small className="nodeConnectedHint">System prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => onChange({ prompt: event.target.value })}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>model</span>
          <select
            className="nodrag nopan nodeInput nodeSelect"
            value={String(params.model ?? "gemini-2.5-flash-lite")}
            onChange={(event) => onChange({ model: event.target.value })}
          >
            {GEMINI_LLM_MODEL_OPTIONS.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </select>
          <small className="nodeConnectedHint">{geminiLlmPricingLabel(String(params.model ?? "gemini-2.5-flash-lite"))}</small>
        </label>
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

function NodeInlineResult({ result, onOpenImage }: { result: NodeRunResult; onOpenImage?: (image: ImageViewerState) => void }) {
  const imageSrc = imagePreviewSrc(result.output);
  const cost = costLabel(result.output);
  const statusText = result.status && result.status !== "succeeded" ? result.status : null;
  const imageTitle = imageLabel(result.output);
  if (imageSrc) {
    return (
      <div className={`nodeResult ${result.status === "failed" ? "failed" : "succeeded"}`}>
        {statusText ? <div>{statusText}</div> : null}
        {cost ? <span className="nodeCost">{cost}</span> : null}
        <div className="nodeImageActions">
          <button
            className="nodeImageActionButton nodrag nopan"
            type="button"
            title="View image"
            onClick={(event) => {
              event.stopPropagation();
              onOpenImage?.({ src: imageSrc, title: imageTitle, filename: downloadFilename(result.output) });
            }}
          >
            <Eye size={16} strokeWidth={2.2} />
          </button>
          <a className="nodeImageActionButton nodrag nopan" href={imageSrc} download={downloadFilename(result.output)} title="Download image">
            <Download size={14} />
          </a>
        </div>
        <img className="nodeImagePreview" src={imageSrc} alt="" />
        <pre>{truncateText(imageTitle, 220)}</pre>
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

type ImageViewerState = {
  src: string;
  title: string;
  filename: string;
};

type PortSpec = {
  id: string;
  kind: PortKind;
  label?: string;
  maxConnections?: number;
};

function getNodePorts(type: string): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (type === "input.text") return { inputs: [], outputs: [{ id: "text", kind: "text" }] };
  if (type === "input.file") return { inputs: [], outputs: [{ id: "file", kind: "file" }] };
  if (type === "input.image") return { inputs: [], outputs: [{ id: "image", kind: "image" }] };
  if (type === "input.video") return { inputs: [], outputs: [{ id: "video", kind: "video" }] };
  if (type === "replicate.clarity-upscaler") {
    return {
      inputs: [
        { id: "image", kind: "image" },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "gemini.nano-banana-2") {
    return {
      inputs: [
        { id: "images", kind: "image", maxConnections: 14 },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "gemini.llm") {
    return {
      inputs: [
        { id: "systemPrompt", kind: "text", label: "system" },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "text", kind: "text" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "preview.image") return { inputs: [{ id: "image", kind: "image" }], outputs: [{ id: "image", kind: "image" }] };
  if (type === "replicate.model") return { inputs: [{ id: "input", kind: "json", label: "JSON" }], outputs: [{ id: "output", kind: "json", label: "JSON" }] };
  if (type === "output.text") return { inputs: [{ id: "from", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "output.file") return { inputs: [{ id: "from", kind: "text" }], outputs: [] };
  if (type === "transform.template") return { inputs: [{ id: "template", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "debug.log") return { inputs: [{ id: "value", kind: "json", label: "JSON" }], outputs: [{ id: "value", kind: "json", label: "JSON" }] };
  return { inputs: [{ id: "input", kind: "json", label: "JSON" }], outputs: [{ id: "output", kind: "json", label: "JSON" }] };
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

function countInputConnections(edges: Edge[], nodeId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    if (edge.target !== nodeId || !edge.targetHandle) continue;
    counts[edge.targetHandle] = (counts[edge.targetHandle] ?? 0) + 1;
  }
  return counts;
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

function canImportDroppedRouteFile(file: File): boolean {
  return /\.(orp|opt|route)(\.(json|ya?ml))?$/i.test(file.name) || /\.(json|ya?ml)$/i.test(file.name);
}

function routeImportFilename(file: File): string {
  return file.name.replace(/\.opt(?=$|\.)/i, ".orp");
}

function uniqueFlowId(preferredId: string, usedIds: Set<string>): string {
  if (!usedIds.has(preferredId)) {
    usedIds.add(preferredId);
    return preferredId;
  }

  let index = 2;
  let candidate = `${preferredId}_${index}`;
  while (usedIds.has(candidate)) {
    index += 1;
    candidate = `${preferredId}_${index}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function isReplicateNode(type: string): boolean {
  return type === "replicate.model" || type === "replicate.clarity-upscaler";
}

function isGeminiNode(type: string): boolean {
  return type === "gemini.nano-banana-2" || type === "gemini.llm";
}

function shouldShowInlineResult(type: string): boolean {
  return !type.startsWith("input.");
}

function shouldShowNodeRunButton(type: string): boolean {
  return !type.startsWith("input.");
}

function nodeIcon(type: string) {
  if (type === "input.text") return <Type size={15} />;
  if (type === "input.image") return <ImageIcon size={15} />;
  if (type === "input.video") return <Video size={15} />;
  if (type === "transform.template") return <Braces size={15} />;
  if (type === "replicate.clarity-upscaler") return <Wand2 size={15} />;
  if (type === "replicate.model") return <span className="providerGlyph">R</span>;
  if (type === "gemini.llm") return <Type size={15} />;
  if (type === "gemini.nano-banana-2") return <Sparkles size={15} />;
  if (type === "preview.image") return <Eye size={15} />;
  if (type === "debug.log") return <Bug size={15} />;
  if (type === "output.text") return <FileText size={15} />;
  if (type === "output.file") return <Save size={15} />;
  return <FileJson size={15} />;
}

function nodeIconClass(type: string): string {
  if (type.startsWith("input.")) return "input";
  if (type.startsWith("output.")) return "output";
  if (type.startsWith("replicate.")) return "replicate";
  if (type.startsWith("gemini.")) return "gemini";
  if (type.startsWith("preview.")) return "preview";
  if (type.startsWith("debug.")) return "debug";
  if (type.startsWith("transform.")) return "transform";
  return "generic";
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

function flowToNodeRoute(nodes: Node[], edges: Edge[], baseRoute: RouteDoc, targetNodeId: string): RouteDoc {
  const included = new Set<string>([targetNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (included.has(edge.target) && !included.has(edge.source)) {
        included.add(edge.source);
        changed = true;
      }
    }
  }
  return flowToRoute(
    nodes.filter((node) => included.has(node.id)),
    edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
    {
      ...baseRoute,
      route: {
        ...baseRoute.route,
        id: `${baseRoute.route.id}-${targetNodeId}`,
        title: `${baseRoute.route.title}: ${targetNodeId}`
      }
    }
  );
}

function App() {
  const initial = useMemo(() => routeToFlow(blankRoute), []);
  const [routeBase, setRouteBase] = useState<RouteDoc>(blankRoute);
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
  const [geminiToken, setGeminiToken] = useState("");
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [apiConnected, setApiConnected] = useState(false);
  const [apiError, setApiError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [pendingBrowse, setPendingBrowse] = useState<{ nodeId: string; kind: AssetKind } | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [bottomCollapsed, setBottomCollapsed] = useState(true);
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [imageViewer, setImageViewer] = useState<ImageViewerState | null>(null);
  const [collapsedLibrarySections, setCollapsedLibrarySections] = useState<Record<string, boolean>>(
    () => Object.fromEntries(librarySections.map((section) => [section.id, true]))
  );

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
          onConfigureReplicate: openReplicateSettings,
          onConfigureGemini: openGeminiSettings,
          onOpenImage: setImageViewer,
          onRunNodeOnly: runNodeOnly,
          onRunNodeWithDependencies: runNodeWithDependencies,
          connectedInputPorts: edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetHandle).filter((handle): handle is string => Boolean(handle)),
          inputConnectionCounts: countInputConnections(edges, node.id),
          canRunNodeOnly: canRunNodeOnly(node.id),
          replicateConfigured,
          geminiConfigured,
          result: runResult?.nodeResults?.[node.id]
        }
      })),
    [nodes, edges, runResult, replicateConfigured, geminiConfigured]
  );

  useEffect(() => {
    void loadSettings();
    void loadLedgerSummary();
  }, []);

  async function loadSettings() {
    try {
      const response = await fetch(`${apiBase}/api/settings`);
      if (!response.ok) throw new Error(localApiUnavailableMessage(apiBase));
      const result = await response.json();
      setReplicateConfigured(Boolean(result.replicate?.configured ?? result.replicateConfigured));
      setGeminiConfigured(Boolean(result.gemini?.configured ?? result.geminiConfigured));
      setApiConnected(true);
      setApiError("");
    } catch {
      const message = localApiUnavailableMessage(apiBase);
      setApiConnected(false);
      setReplicateConfigured(false);
      setGeminiConfigured(false);
      setApiError(message);
      setSettingsMessage(message);
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
      setReplicateConfigured(Boolean(result.replicate?.configured ?? result.replicateConfigured));
      setReplicateToken("");
      setSettingsMessage("Replicate token saved locally.");
      setLogs((current) => ["Replicate token saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  async function saveGeminiToken() {
    const token = geminiToken.trim();
    if (!token) {
      setSettingsMessage("Gemini key cannot be empty.");
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/settings/gemini-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey: token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Failed to save Gemini key.");
      setGeminiConfigured(Boolean(result.gemini?.configured ?? result.geminiConfigured));
      setGeminiToken("");
      setSettingsMessage("Gemini key saved locally.");
      setLogs((current) => ["Gemini key saved locally.", ...current]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsMessage(message);
      setLogs((current) => [`Settings error: ${message}`, ...current]);
    }
  }

  function openReplicateSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your Replicate token in Settings \u2192 Secrets \u2192 Replicate.");
  }

  function openGeminiSettings() {
    setRightCollapsed(false);
    setSettingsMessage("Paste your Gemini API key in Settings \u2192 Secrets \u2192 Gemini.");
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

  async function importRouteOntoCanvas(file: File, position: { x: number; y: number }) {
    const route = loadRouteFromText(await file.text(), routeImportFilename(file)) as RouteDoc;
    const imported = routeToFlow(route);
    const usedNodeIds = new Set(nodes.map((node) => node.id));
    const usedEdgeIds = new Set(edges.map((edge) => edge.id));
    const nodeIdMap = new Map<string, string>();
    const minX = Math.min(...imported.nodes.map((node) => node.position.x), position.x);
    const minY = Math.min(...imported.nodes.map((node) => node.position.y), position.y);
    const offset = { x: position.x - minX, y: position.y - minY };

    const importedNodes = imported.nodes.map((node) => {
      const importedId = uniqueFlowId(node.id, usedNodeIds);
      nodeIdMap.set(node.id, importedId);
      const routeNode = { ...(node.data.routeNode as RouteDoc["nodes"][number]), id: importedId };
      return {
        ...node,
        id: importedId,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
        data: { ...node.data, label: `${routeNode.title ?? routeNode.id}\n${routeNode.type}`, routeNode }
      };
    });

    const importedEdges = imported.edges.map((edge, index) => ({
      ...edge,
      id: uniqueFlowId(edge.id ?? `${edge.source}-${edge.target}-${index}`, usedEdgeIds),
      source: nodeIdMap.get(edge.source) ?? edge.source,
      target: nodeIdMap.get(edge.target) ?? edge.target
    }));

    setNodes((current) => [...current, ...importedNodes]);
    setEdges((current) => [...current, ...importedEdges]);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [`Imported ${file.name} onto canvas.`, ...current]);
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
    if (canImportDroppedRouteFile(file)) {
      try {
        await importRouteOntoCanvas(file, flowPositionFromEvent(event));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLogs((entries) => [`Drop route import error: ${message}`, ...entries]);
      }
      return;
    }

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
          <span className={`libraryNodeIcon ${nodeIconClass(item.type)}`}>{nodeIcon(item.type)}</span>
          <strong>{item.label}</strong>
          <span>{item.type}</span>
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
    const existingCount = edges.filter((edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle).length;
    if (existingCount >= (targetPort.maxConnections ?? 1)) return false;
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

  async function runNodeWithDependencies(nodeId: string) {
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return;
    const route = flowToNodeRoute(nodes, edges, routeBase, nodeId);
    setRunResult({
      status: "running",
      nodeResults: Object.fromEntries(route.nodes.map((node) => [node.id, { status: "pending" }]))
    });
    setLogs((current) => [`Running ${nodeId} and ${Math.max(route.nodes.length - 1, 0)} upstream dependency node(s).`, ...current]);
    const response = await fetch(`${apiBase}/api/routes/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(route) });
    const result = await response.json();
    setOutputs(result);
    setRunResult(result);
    void loadLedgerSummary();
    const runLogs = Array.isArray(result.logs) ? result.logs.map((entry: { message: string }) => entry.message) : [result.error ?? "Run failed."];
    setLogs((current) => [...runLogs.reverse(), ...current]);
  }

  function canRunNodeOnly(nodeId: string): boolean {
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return false;
    const targetNode = target.data.routeNode as RouteDoc["nodes"][number];
    const incomingEdges = edges.filter((edge) => edge.target === nodeId);
    const connectedInputsReady = incomingEdges.every((edge) => isReadySourceForNodeOnlyRun(edge.source));
    return connectedInputsReady && hasRequiredNodeOnlyInputs(targetNode, incomingEdges);
  }

  async function runNodeOnly(nodeId: string) {
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return;
    const routeNode = target.data.routeNode as RouteDoc["nodes"][number];
    const incomingEdges = edges.filter((edge) => edge.target === nodeId);
    const initialNodeOutputs: Record<string, unknown> = {};
    const missing = new Set<string>();

    for (const edge of incomingEdges) {
      const previous = runResult?.nodeResults?.[edge.source];
      if (previous?.status !== "succeeded" || previous.output === undefined) {
        if (!isImmediateInputSource(edge.source)) missing.add(edge.source);
      } else {
        initialNodeOutputs[edge.source] = previous.output;
      }
    }

    if (missing.size > 0) {
      const message = `Cannot run ${nodeId} only: missing ready upstream output(s): ${[...missing].join(", ")}. Run dependencies first.`;
      setRunResult((current) => ({
        ...(current ?? {}),
        status: "failed",
        nodeResults: {
          ...(current?.nodeResults ?? {}),
          [nodeId]: { status: "failed", error: message }
        }
      }));
      setLogs((current) => [message, ...current]);
      return;
    }

    const sourceNodeIds = new Set(incomingEdges.map((edge) => edge.source));
    const routeNodes = nodes.filter((node) => node.id === nodeId || sourceNodeIds.has(node.id));
    const route = flowToRoute(routeNodes, incomingEdges, {
      ...routeBase,
      route: { ...routeBase.route, id: `${routeBase.route.id}-${nodeId}-only`, title: `${routeBase.route.title}: ${nodeId} only` }
    });
    setRunResult((current) => ({
      ...(current ?? {}),
      status: "running",
      nodeResults: {
        ...(current?.nodeResults ?? {}),
        [nodeId]: { status: "pending" }
      }
    }));
    setLogs((current) => [`Running ${routeNode.id} only.`, ...current]);
    const response = await fetch(`${apiBase}/api/routes/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route, initialNodeOutputs })
    });
    const result = await response.json();
    setOutputs(result);
    setRunResult((current) => ({
      ...result,
      nodeResults: {
        ...(current?.nodeResults ?? {}),
        ...(result.nodeResults ?? {})
      }
    }));
    void loadLedgerSummary();
    const runLogs = Array.isArray(result.logs) ? result.logs.map((entry: { message: string }) => entry.message) : [result.error ?? "Run failed."];
    setLogs((current) => [...runLogs.reverse(), ...current]);
  }

  function isReadySourceForNodeOnlyRun(sourceNodeId: string): boolean {
    const previous = runResult?.nodeResults?.[sourceNodeId];
    return (previous?.status === "succeeded" && previous.output !== undefined) || isImmediateInputSource(sourceNodeId);
  }

  function isImmediateInputSource(sourceNodeId: string): boolean {
    const source = nodes.find((node) => node.id === sourceNodeId);
    const routeNode = source?.data.routeNode as RouteDoc["nodes"][number] | undefined;
    if (!routeNode) return false;
    if (routeNode.type === "input.text") return true;
    if (routeNode.type === "input.file" || routeNode.type === "input.image" || routeNode.type === "input.video") {
      return Boolean(String(routeNode.params?.path ?? "").trim());
    }
    return false;
  }

  function exportRoute() {
    const filename = normalizeRouteExportFilename(`${routeBase.route.id || "studio-route"}`);
    const blob = new Blob([exportRouteToText(flowToRoute(nodes, edges, routeBase) as OpenRoute, filename)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function applyRoute(route: RouteDoc, logMessage: string) {
    const flow = routeToFlow(route);
    setRouteBase(route);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setRunResult(null);
    setOutputs(null);
    setLogs((current) => [logMessage, ...current]);
  }

  function saveProject() {
    try {
      const filename = normalizeRouteExportFilename(`${routeBase.route.id || "studio-route"}`);
      const text = exportRouteToText(flowToRoute(nodes, edges, routeBase) as OpenRoute, filename);
      localStorage.setItem(SAVED_PROJECT_STORAGE_KEY, text);
      setLogs((current) => ["Saved current project locally.", ...current]);
    } catch (error) {
      setLogs((current) => [`Save failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function loadSavedProject() {
    try {
      const text = localStorage.getItem(SAVED_PROJECT_STORAGE_KEY);
      if (!text) {
        setLogs((current) => ["No saved project found.", ...current]);
        return;
      }
      applyRoute(loadRouteFromText(text, "saved-project.orp.json") as RouteDoc, "Loaded saved project.");
    } catch (error) {
      setLogs((current) => [`Load failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  async function importRoute(file: File | null) {
    if (!file) return;
    try {
      const route = loadRouteFromText(await file.text(), file.name) as RouteDoc;
      applyRoute(route, `Imported ${file.name}.`);
    } catch (error) {
      setLogs((current) => [`Import failed: ${error instanceof Error ? error.message : String(error)}`, ...current]);
    }
  }

  function loadExample() {
    applyRoute(exampleRoute, "Loaded Gemini prompt-to-image example.");
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
          <button onClick={exportRoute} title="Export route"><Download size={16} /> Export</button>
          <label className="fileButton" title="Import route"><Upload size={16} /> Import<input type="file" accept={ROUTE_FILE_ACCEPT} onChange={(event) => void importRoute(event.target.files?.[0] ?? null)} /></label>
          <button onClick={saveProject} title="Save current project"><Save size={16} /> Save</button>
          <button onClick={loadSavedProject} title="Load saved project"><FolderOpen size={16} /> Load</button>
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
          <button className="primary" onClick={() => void run()}><Play size={16} /> Run</button>
          <button className="danger" onClick={deleteSelection} disabled={selectedNodeCount === 0 && selectedEdgeCount === 0 && !selectedId}><Trash2 size={16} /> Delete</button>
          <div className={`apiStatus ${apiConnected ? "connected" : "disconnected"}`} title={apiError || `API: ${apiBase}`}>
            <span>API: {apiBase}</span>
            <strong>{apiConnected ? "connected" : "disconnected"}</strong>
            <em>{apiConnected ? (replicateConfigured ? "replicate: configured" : "replicate: missing") : "replicate: unknown"}</em>
            <em>{apiConnected ? (geminiConfigured ? "gemini: configured" : "gemini: missing") : "gemini: unknown"}</em>
          </div>
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
          <div className={`apiStatusPanel ${apiConnected ? "connected" : "disconnected"}`}>
            <span>API</span>
            <strong>{apiBase}</strong>
            <em>{apiConnected ? "connected" : "disconnected"}</em>
            {apiError ? <p>{apiError}</p> : null}
          </div>
          <h3>Secrets</h3>
          <h4>Replicate</h4>
          <div className={`settingsStatus ${replicateConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            {replicateTokenStatusText(replicateConfigured)}
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
          <h4>Gemini</h4>
          <div className={`settingsStatus ${geminiConfigured ? "configured" : ""}`}>
            <KeyRound size={14} />
            {geminiTokenStatusText(geminiConfigured)}
          </div>
          {!geminiConfigured ? (
            <a className="settingsLink" href={GEMINI_API_KEY_URL} target="_blank" rel="noreferrer">
              Get Gemini API key in Google AI Studio
            </a>
          ) : null}
          <label className="settingsField">
            <span>GEMINI_API_KEY</span>
            <input
              type="password"
              value={geminiToken}
              placeholder="Paste key"
              onChange={(event) => setGeminiToken(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button onClick={() => void saveGeminiToken()}><Save size={16} /> Save Key</button>
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

      {imageViewer ? (
        <div className="imageViewerOverlay" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setImageViewer(null)}>
          <div className="imageViewerWindow" onClick={(event) => event.stopPropagation()}>
            <div className="imageViewerHeader">
              <span title={imageViewer.title}>{truncateText(imageViewer.title, 96)}</span>
              <div className="imageViewerActions">
                <a className="imageViewerButton" href={imageViewer.src} download={imageViewer.filename} title="Download image">
                  <Download size={15} />
                </a>
                <button className="imageViewerButton" type="button" title="Close" onClick={() => setImageViewer(null)}>
                  <X size={15} />
                </button>
              </div>
            </div>
            <img className="imageViewerImage" src={imageViewer.src} alt={imageViewer.title} />
          </div>
        </div>
      ) : null}
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

function geminiLlmPricingLabel(modelValue: string): string {
  const model = GEMINI_LLM_MODEL_OPTIONS.find((entry) => entry.value === modelValue) ?? GEMINI_LLM_MODEL_OPTIONS[0];
  return `Paid tier: input $${model.inputUsdPerMillionTokens.toFixed(2)} / output $${model.outputUsdPerMillionTokens.toFixed(2)} per 1M tokens.`;
}

function downloadFilename(value: unknown): string {
  const label = imageLabel(value).split(/[\\/]/).pop() ?? "snarkroute-image.png";
  return label || "snarkroute-image.png";
}

function filenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function hasRequiredNodeOnlyInputs(node: RouteDoc["nodes"][number], incomingEdges: Edge[]): boolean {
  if (node.type === "replicate.clarity-upscaler") {
    return Boolean(node.params?.image) || incomingEdges.some((edge) => !edge.targetHandle || edge.targetHandle === "image");
  }
  if (node.type === "preview.image") {
    return Boolean(node.params?.image) || incomingEdges.some((edge) => !edge.targetHandle || edge.targetHandle === "image");
  }
  return true;
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
  const parts = [`Estimated provider cost: $${estimatedUsd.toFixed(4)}`];
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
