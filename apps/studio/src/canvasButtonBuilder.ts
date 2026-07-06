import type { NodeManifest, RouteDoc } from "./studioTypes";

type ParamManifest = NonNullable<NodeManifest["params"]>[number];
export type CanvasButtonPreviewKind = "image" | "video" | "audio" | "panorama360" | "splat";
export type CanvasButtonPreviewCandidate = {
  id: string;
  kind: CanvasButtonPreviewKind;
  source: "input" | { output: string } | { pause: string };
  label: string;
};

export type CanvasButtonDraft = {
  nodeId: string;
  title: string;
  packageId: string;
  iconName: string;
  customIconDataUrl?: string;
  inputKind: string;
  outputs: Array<{ id: string; kind: string; label?: string }>;
  params: Array<ParamManifest & { selected: boolean; displayLabel: string }>;
  previewCandidates: CanvasButtonPreviewCandidate[];
  selectedPreviewId: string;
};

const runtimeParamKeys = new Set([
  "output", "outputImage", "renderedImage", "renderedPanorama", "panoramaImage",
  "marbleWorld", "pinnedMarbleWorld", "sourceImageHash", "pinnedOutput",
  "pinnedOutputAt", "pollingIntervalMs", "timeoutMs"
]);

export function canvasButtonParamCandidates(
  compoundNode: RouteDoc["nodes"][number],
  manifests: Iterable<NodeManifest>,
  typeDefaults: Iterable<{ type: string; params?: Record<string, unknown> }>
): CanvasButtonDraft["params"] {
  const manifestByType = new Map(Array.from(manifests, (manifest) => [manifest.id, manifest]));
  const defaultsByType = new Map(Array.from(typeDefaults, (entry) => [entry.type, entry.params ?? {}]));
  return (compoundNode.subroute?.nodes ?? []).flatMap((internalNode) => {
    const declared = manifestByType.get(internalNode.type)?.params ?? [];
    const defaults = defaultsByType.get(internalNode.type) ?? {};
    const values = internalNode.params ?? {};
    const merged = new Map<string, ParamManifest>();
    for (const key of new Set([...Object.keys(defaults), ...Object.keys(values)])) {
      if (runtimeParamKeys.has(key)) continue;
      const value = values[key] ?? defaults[key];
      if (isUndeclaredStructuredValue(value) || isIsoTimestampParam(key, value)) continue;
      merged.set(key, { id: key, type: inferredParamType(value), default: value });
    }
    for (const param of declared) merged.set(param.id, { ...param, default: values[param.id] ?? param.default ?? defaults[param.id] });
    return Array.from(merged.values(), (param) => ({
      ...param,
      id: `${internalNode.id}.${param.id}`,
      label: param.label ?? param.id,
      binding: { nodeId: internalNode.id, paramId: param.id },
      selected: false,
      displayLabel: param.label ?? param.id
    }));
  });
}

export function canvasButtonPreviewCandidates(compoundNode: RouteDoc["nodes"][number], inputKind: string): CanvasButtonPreviewCandidate[] {
  const outputs = compoundNode.compound?.outputs ?? [];
  const candidates: CanvasButtonPreviewCandidate[] = [];
  if (isBasicPreviewKind(inputKind)) candidates.push({ id: "input", kind: inputKind, source: "input", label: "Input" });
  for (const internalNode of compoundNode.subroute?.nodes ?? []) {
    const kind = internalNode.type === "preview.panorama360" ? "panorama360" : /splat/i.test(internalNode.type) ? "splat" : null;
    if (!kind) continue;
    candidates.push({ id: `node:${internalNode.id}:pause`, kind, source: { pause: internalNode.id }, label: `${internalNode.title ?? internalNode.id} (${kind === "panorama360" ? "360" : "splat"})` });
  }
  for (const output of outputs) {
    const kind = String(output.kind ?? "");
    if (!isBasicPreviewKind(kind)) continue;
    candidates.push({ id: `output:${output.id}`, kind, source: { output: output.id }, label: output.label ?? output.id });
  }
  return candidates;
}

export function defaultCanvasButtonPreviewId(candidates: CanvasButtonPreviewCandidate[]): string {
  return candidates.find((candidate) => candidate.kind === "panorama360")?.id ?? "";
}

export function canvasButtonManifestFromDraft(draft: CanvasButtonDraft, compoundNode: RouteDoc["nodes"][number]): NodeManifest | null {
  const title = draft.title.trim();
  const id = draft.packageId.trim();
  if (compoundNode.type !== "compound.subroute" || !compoundNode.subroute || !title || !id) return null;
  const selectedPreview = draft.previewCandidates.find((candidate) => candidate.id === draft.selectedPreviewId);
  const pauseNodeId = selectedPreview && selectedPreview.source !== "input" && "pause" in selectedPreview.source ? selectedPreview.source.pause : null;
  const selectedParams = draft.params.filter((param) => param.selected || (pauseNodeId === param.binding?.nodeId && poseAxis(param.binding.paramId))).map(({ selected: _selected, displayLabel: _displayLabel, ...param }) => param);
  const poseBindings = canvasButtonPoseBindings(selectedParams);
  const icon = draft.customIconDataUrl ? { kind: "custom" as const, dataUrl: draft.customIconDataUrl } : { kind: "preset" as const, name: draft.iconName };
  return nodeManifestFromCompoundNode(compoundNode, id, title, {
    canvasAction: { enabled: true, icon, params: selectedParams, poseBindings, preview: selectedPreview ? [{ kind: selectedPreview.kind, source: selectedPreview.source }] : undefined }
  });
}

export function nodeManifestFromCompoundNode(compoundNode: RouteDoc["nodes"][number], id: string, title: string, options: { canvasAction?: { enabled: boolean; icon?: NonNullable<NodeManifest["canvasAction"]>["icon"]; params?: NonNullable<NodeManifest["params"]>; poseBindings?: NonNullable<NodeManifest["canvasAction"]>["poseBindings"]; preview?: NonNullable<NonNullable<NodeManifest["canvasAction"]>["dialog"]>["preview"] } } = {}): NodeManifest {
  const compound = compoundNode.compound ?? {};
  const inputs = (compound.inputs ?? []).map((port) => ({ id: port.id, type: String(port.kind ?? "json"), label: port.label ?? port.id }));
  const outputs = (compound.outputs ?? []).map((port) => ({ id: port.id, type: String(port.kind ?? "json"), label: port.label ?? port.id }));
  return {
    kind: "snarkroute.node", schemaVersion: "0.1", id, title, version: "0.1.0",
    author: { name: "SnarkRoute Studio" }, license: "UNLICENSED", origin: "generated", source: "snarkroute-studio", category: "Compound",
    description: `Generated from compound route "${compound.title ?? compoundNode.title ?? compoundNode.id}".`,
    permissions: { network: false, networkHosts: [], readFiles: false, writeOutputs: false, shell: false, env: [] },
    executor: { type: "declarative" }, inputs, outputs,
    ...(options.canvasAction?.params?.length ? { params: options.canvasAction.params } : {}),
    ...(options.canvasAction?.enabled ? { canvasAction: {
      enabled: true, title, description: `Run "${title}" from the Living Canvas node toolbar.`, icon: options.canvasAction.icon ?? { kind: "preset", name: "wrench" },
      ...(options.canvasAction.poseBindings && Object.keys(options.canvasAction.poseBindings).length ? { poseBindings: options.canvasAction.poseBindings } : {}),
      ...(options.canvasAction.params?.length || options.canvasAction.preview?.length ? { dialog: { enabled: true, params: (options.canvasAction.params ?? []).map((param) => param.id), ...(options.canvasAction.preview?.length ? { preview: options.canvasAction.preview } : {}) } } : {})
    } } : {}),
    generatedWith: { tool: "snarkroute-studio", kind: "compound.subroute", compound: { ...compound, title }, subroute: compoundNode.subroute }
  };
}

function canvasButtonPoseBindings(params: NonNullable<NodeManifest["params"]>): NonNullable<NodeManifest["canvasAction"]>["poseBindings"] {
  const result: NonNullable<NodeManifest["canvasAction"]>["poseBindings"] = {};
  for (const param of params) {
    const axis = param.binding ? poseAxis(param.binding.paramId) : undefined;
    if (axis) result[axis] = param.id;
  }
  return result;
}

function poseAxis(paramId: string): keyof NonNullable<NonNullable<NodeManifest["canvasAction"]>["poseBindings"]> | undefined {
  const aliases: Record<string, keyof NonNullable<NonNullable<NodeManifest["canvasAction"]>["poseBindings"]>> = {
    yaw: "yaw", yawDegrees: "yaw", pitch: "pitch", pitchDegrees: "pitch", roll: "roll", rollDegrees: "roll", fov: "fov", fovDegrees: "fov",
    positionX: "positionX", positionY: "positionY", positionZ: "positionZ"
  };
  return aliases[paramId];
}

function inferredParamType(value: unknown): string {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
}

function isUndeclaredStructuredValue(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function isIsoTimestampParam(key: string, value: unknown): boolean {
  return key.endsWith("At")
    && typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function isBasicPreviewKind(value: string): value is "image" | "video" | "audio" {
  return value === "image" || value === "video" || value === "audio";
}
