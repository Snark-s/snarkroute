export type CanvasActionPortType = "image" | "video" | "audio" | "text";
export type CanvasActionPreviewKind = CanvasActionPortType | "panorama360" | "splat";

export interface CanvasActionParam {
  id: string;
  type: string;
  label?: string;
  description?: string;
  default?: unknown;
  options?: Array<{ value: unknown; label?: string }>;
  min?: number;
  max?: number;
  step?: number;
  binding?: { nodeId: string; paramId: string };
  poseManaged?: boolean;
}

export interface CanvasNodeAction {
  id: string;
  title: string;
  description: string;
  inputType: CanvasActionPortType;
  outputs: Array<{ id: string; type: CanvasActionPortType; label: string }>;
  params?: CanvasActionParam[];
  dialog?: {
    enabled: boolean;
    params: string[];
    preview?: Array<{
      kind: CanvasActionPreviewKind;
      source: "input" | { output: string } | { pause: string };
    }>;
  };
  poseBindings?: Partial<Record<"yaw" | "pitch" | "roll" | "fov" | "positionX" | "positionY" | "positionZ" | "cameraPose", string>>;
  icon?: { kind: "preset"; name: string } | { kind: "custom"; svg?: string; dataUrl?: string };
  node?: unknown;
}

export type ToolInputState =
  | { kind: "empty"; expectedType: CanvasActionPortType; needsReselection?: boolean; filename?: string }
  | { kind: "text"; type: "text"; text: string }
  | { kind: "file"; type: "image" | "video" | "audio"; file: File; previewUrl?: string };

export interface ToolResult {
  id: string;
  outputId: string;
  type: CanvasActionPortType;
  label: string;
  value?: unknown;
  text?: string;
  url?: string;
  filename?: string;
}

export interface ToolTabState {
  id: string;
  actionId: string;
  title: string;
  input: ToolInputState;
  params: Record<string, unknown>;
  status: "idle" | "running" | "paused" | "completed" | "error";
  continuationId?: string;
  preparedPreviews?: Array<{ kind: "panorama360" | "splat"; src: string }>;
  results: ToolResult[];
  error?: string;
}

export interface PersistedToolTabState extends Omit<ToolTabState, "input" | "results"> {
  input: Exclude<ToolInputState, { kind: "file" }> | { kind: "empty"; expectedType: CanvasActionPortType; needsReselection: true; filename?: string };
  results: ToolResult[];
}

export function canvasActionNeedsDialog(action: Pick<CanvasNodeAction, "dialog"> | undefined): boolean {
  const dialog = action?.dialog;
  return dialog?.enabled === true && (dialog.params.length > 0 || Boolean(dialog.preview?.length));
}

export function visibleCanvasActionParams(action: CanvasNodeAction): CanvasActionParam[] {
  if (!action.dialog?.enabled) return [];
  const visible = new Set(action.dialog.params);
  return (action.params ?? []).filter((param) => visible.has(param.id) && !param.poseManaged);
}

export function initialCanvasActionParams(action: CanvasNodeAction, saved: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(visibleCanvasActionParams(action).map((param) => [
    param.id,
    saved[param.id] ?? param.default ?? defaultParamValue(param.type)
  ]));
}

export function canvasActionBoundParams(action: CanvasNodeAction, values: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const visible = new Set(action.dialog?.params ?? []);
  const bound: Record<string, Record<string, unknown>> = {};
  for (const param of action.params ?? []) {
    if (!visible.has(param.id) || !param.binding || values[param.id] === undefined) continue;
    bound[param.binding.nodeId] = { ...(bound[param.binding.nodeId] ?? {}), [param.binding.paramId]: values[param.id] };
  }
  return bound;
}

export function createToolTab(action: CanvasNodeAction, id: string, saved: Record<string, unknown> = {}): ToolTabState {
  return {
    id,
    actionId: action.id,
    title: action.title,
    input: action.inputType === "text" ? { kind: "text", type: "text", text: "" } : { kind: "empty", expectedType: action.inputType },
    params: initialCanvasActionParams(action, saved),
    status: "idle",
    results: []
  };
}

export function persistToolTab(tab: ToolTabState): PersistedToolTabState {
  const input: PersistedToolTabState["input"] = tab.input.kind === "file"
    ? { kind: "empty", expectedType: tab.input.type, needsReselection: true, filename: tab.input.file.name }
    : tab.input;
  return { ...tab, input, continuationId: undefined, preparedPreviews: undefined, status: tab.status === "running" || tab.status === "paused" ? "idle" : tab.status };
}

export function updateToolTab(tabs: ToolTabState[], tabId: string, update: Partial<ToolTabState>): ToolTabState[] {
  return tabs.map((tab) => tab.id === tabId ? { ...tab, ...update } : tab);
}

function defaultParamValue(type: string): unknown {
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  if (type === "json") return {};
  return "";
}
