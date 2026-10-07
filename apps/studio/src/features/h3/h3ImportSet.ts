export type H3ImportMediaKind = "image" | "video" | "audio";

export type H3ImportFile = {
  key: string;
  name: string;
  relativePath?: string;
  type?: string;
  size?: number;
};

export type H3ImportedReference = {
  id: string;
  nodeId?: string;
  kind: H3ImportMediaKind;
  sourceName: string;
  connected: boolean;
  connectionInput?: string;
  classification: "reference" | "previous_stage_output" | "orphaned" | "loose";
  matchedFileKey?: string;
  resolvedSourceName?: string;
  resolvedFromReferenceId?: string;
  resolvedByReferenceId?: string;
  manualRole?: "Video 1";
  missing: boolean;
  disposition: "active" | "unused" | "ignored" | "resolved";
};

export type H3ImportFingerprint = { key: string; name: string; size: number; sha256: string };

export type H3ImportAnalysis = {
  sourceType: "loose_files" | "comfyui_api" | "snarkroute_project" | "unknown_json";
  workflowName: string;
  workflowFileName?: string;
  model?: string;
  prompt?: string;
  contextInstruction?: string;
  generation: {
    resolution?: string;
    ratio?: string;
    duration?: number;
    seed?: number;
    promptExpansionMode?: string;
    referenceDetail?: string;
    watermark?: boolean;
  };
  contextIr: { detected: boolean; enabled?: boolean; exactCompatibility: false };
  stages: {
    promptEnhanceDetected: boolean;
    promptEnhanceEnabled?: boolean;
    regenerate2kDetected: boolean;
    regenerate2kEnabled?: boolean;
    saveTextDetected: boolean;
    saveVideoCount: number;
  };
  references: H3ImportedReference[];
  warnings: string[];
  metadata: Record<string, unknown>;
};

type WorkflowNode = {
  inputs?: Record<string, unknown>;
  class_type?: string;
  _meta?: { title?: string };
};

type WorkflowGraph = Record<string, WorkflowNode>;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi"]);
const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "flac", "ogg", "m4a", "aac", "opus"]);

export function mediaKindForImportFile(file: Pick<H3ImportFile, "name" | "type">): H3ImportMediaKind | null {
  const mimeKind = file.type?.split("/")[0];
  if (mimeKind === "image" || mimeKind === "video" || mimeKind === "audio") return mimeKind;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return null;
}

export function importReferenceLabel(reference: H3ImportedReference, references: H3ImportedReference[]): string {
  const sameKind = references.filter((candidate) => candidate.connected && candidate.kind === reference.kind);
  const index = Math.max(0, sameKind.findIndex((candidate) => candidate.id === reference.id)) + 1;
  const label = reference.kind === "image" ? "Picture" : reference.kind === "video" ? "Video" : "Audio";
  return `${label} ${index}`;
}

export function importReferenceUiGroup(reference: H3ImportedReference): "slot" | "orphan" | "hidden" {
  if (reference.connected || reference.disposition === "active") return "slot";
  if (reference.disposition === "unused" || reference.disposition === "ignored") return "orphan";
  return "hidden";
}

export function compatibleImportCandidates(analysis: H3ImportAnalysis, targetId: string): H3ImportedReference[] {
  const target = analysis.references.find((reference) => reference.id === targetId);
  if (!target?.connected || !target.missing) return [];
  return analysis.references.filter((reference) => !reference.connected && reference.kind === target.kind && Boolean(reference.matchedFileKey) && reference.disposition === "unused");
}

export function importSourcePickerCandidates(analysis: H3ImportAnalysis, targetId: string): H3ImportedReference[] {
  const target = analysis.references.find((reference) => reference.id === targetId);
  if (!target?.connected) return [];
  return analysis.references.filter((reference) => !reference.connected
    && reference.kind === target.kind
    && Boolean(reference.matchedFileKey)
    && (reference.disposition === "unused" || (Boolean(target.matchedFileKey) && reference.disposition === "resolved"))
    && reference.id !== target.resolvedFromReferenceId);
}

export function compatibleImportTargets(analysis: H3ImportAnalysis, candidateId: string): H3ImportedReference[] {
  const candidate = analysis.references.find((reference) => reference.id === candidateId);
  if (!candidate || candidate.connected || !candidate.matchedFileKey || candidate.disposition !== "unused") return [];
  return analysis.references.filter((reference) => reference.connected && reference.kind === candidate.kind && reference.missing);
}

export function resolveImportReference(analysis: H3ImportAnalysis, targetId: string, candidateId: string): H3ImportAnalysis {
  const target = analysis.references.find((reference) => reference.id === targetId);
  const candidate = analysis.references.find((reference) => reference.id === candidateId);
  if (!target?.connected || !target.missing || !candidate || candidate.connected || candidate.kind !== target.kind || !candidate.matchedFileKey || candidate.disposition !== "unused") return analysis;
  return resolveImportSource(analysis, targetId, candidate.matchedFileKey, candidate.sourceName, candidateId);
}

export function changeImportReferenceSource(analysis: H3ImportAnalysis, targetId: string, candidateId: string): H3ImportAnalysis {
  const target = analysis.references.find((reference) => reference.id === targetId);
  const candidate = analysis.references.find((reference) => reference.id === candidateId);
  if (!target?.connected || !candidate || candidate.connected || candidate.kind !== target.kind || !candidate.matchedFileKey || candidate.disposition !== "unused") return analysis;
  const released = target.matchedFileKey ? unassignImportReference(analysis, targetId) : analysis;
  return resolveImportReference(released, targetId, candidateId);
}

export function importAssignmentConflict(analysis: H3ImportAnalysis, targetId: string, candidateId: string): H3ImportedReference | undefined {
  const candidate = analysis.references.find((reference) => reference.id === candidateId);
  if (!candidate?.resolvedByReferenceId || candidate.resolvedByReferenceId === targetId) return undefined;
  return analysis.references.find((reference) => reference.id === candidate.resolvedByReferenceId && reference.connected);
}

export function swapImportReferenceSources(analysis: H3ImportAnalysis, firstTargetId: string, secondTargetId: string): H3ImportAnalysis {
  const first = analysis.references.find((reference) => reference.id === firstTargetId && reference.connected);
  const second = analysis.references.find((reference) => reference.id === secondTargetId && reference.connected);
  if (!first?.matchedFileKey || !second?.matchedFileKey || first.kind !== second.kind) return analysis;
  const sourceFields = (reference: H3ImportedReference) => ({
    matchedFileKey: reference.matchedFileKey,
    resolvedSourceName: reference.resolvedSourceName,
    resolvedFromReferenceId: reference.resolvedFromReferenceId,
    missing: false,
  });
  return {
    ...analysis,
    references: analysis.references.map((reference) => {
      if (reference.id === firstTargetId) return { ...reference, ...sourceFields(second) };
      if (reference.id === secondTargetId) return { ...reference, ...sourceFields(first) };
      if (reference.resolvedByReferenceId === firstTargetId) return { ...reference, resolvedByReferenceId: secondTargetId };
      if (reference.resolvedByReferenceId === secondTargetId) return { ...reference, resolvedByReferenceId: firstTargetId };
      return reference;
    }),
  };
}

export function unassignImportReference(analysis: H3ImportAnalysis, targetId: string): H3ImportAnalysis {
  const target = analysis.references.find((reference) => reference.id === targetId);
  if (!target?.connected || !target.matchedFileKey) return analysis;
  const restoredCandidateId = target.resolvedFromReferenceId;
  const hasCandidate = Boolean(restoredCandidateId && analysis.references.some((reference) => reference.id === restoredCandidateId));
  const references = analysis.references.map((reference) => {
    if (reference.id === targetId) {
      const { matchedFileKey: _matchedFileKey, resolvedSourceName: _resolvedSourceName, resolvedFromReferenceId: _resolvedFromReferenceId, ...rest } = reference;
      return { ...rest, missing: true };
    }
    if (restoredCandidateId && reference.id === restoredCandidateId) {
      const { resolvedByReferenceId: _resolvedByReferenceId, ...rest } = reference;
      return { ...rest, disposition: "unused" as const };
    }
    return reference;
  });
  if (!hasCandidate) references.push({
    id: `released-${target.id}-${target.matchedFileKey}`,
    kind: target.kind,
    sourceName: target.resolvedSourceName ?? target.sourceName,
    connected: false,
    classification: "orphaned",
    matchedFileKey: target.matchedFileKey,
    missing: false,
    disposition: "unused",
  });
  const warning = `${importReferenceLabel(target, analysis.references)} uses ${target.sourceName}, but the source file is missing.`;
  return { ...analysis, references, warnings: analysis.warnings.includes(warning) ? analysis.warnings : [...analysis.warnings, warning] };
}

export function attachImportFileToReference(analysis: H3ImportAnalysis, targetId: string, file: H3ImportFile): H3ImportAnalysis {
  const target = analysis.references.find((reference) => reference.id === targetId);
  const kind = mediaKindForImportFile(file);
  if (!target?.connected || kind !== target.kind) return analysis;
  const candidateId = `manual-file-${targetId}-${file.key}`;
  const candidate: H3ImportedReference = { id: candidateId, kind, sourceName: file.relativePath || file.name, connected: false, classification: "orphaned", matchedFileKey: file.key, missing: false, disposition: "unused" };
  const withCandidate = { ...analysis, references: [...analysis.references.filter((reference) => reference.id !== candidateId), candidate] };
  return target.missing ? resolveImportReference(withCandidate, targetId, candidateId) : changeImportReferenceSource(withCandidate, targetId, candidateId);
}

export function extractReferenceContext(text: string | undefined, tag: string, maxSnippets = 3): string[] {
  if (!text?.trim() || !tag.trim()) return [];
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(escaped, "i");
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const snippets = paragraphs.filter((paragraph) => mention.test(paragraph)).flatMap((paragraph) => {
    if (paragraph.length <= 700) return [paragraph];
    const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
    const selected: string[] = [];
    for (let index = 0; index < sentences.length; index += 1) {
      if (!mention.test(sentences[index]!)) continue;
      selected.push([sentences[index], sentences[index + 1]].filter(Boolean).join(" "));
    }
    return selected;
  });
  return Array.from(new Set(snippets)).slice(0, maxSnippets);
}

export function importReferenceContext(analysis: H3ImportAnalysis, tag: string): string[] {
  return Array.from(new Set([
    ...extractReferenceContext(analysis.prompt, `<${tag}>`),
    ...extractReferenceContext(analysis.contextInstruction, `<${tag}>`),
  ])).slice(0, 3);
}

export function addImportAssetAsReference(analysis: H3ImportAnalysis, candidateId: string): H3ImportAnalysis {
  const candidate = analysis.references.find((reference) => reference.id === candidateId);
  if (!candidate || candidate.connected || candidate.disposition === "resolved") return analysis;
  return { ...analysis, references: analysis.references.map((reference) => reference.id === candidateId ? { ...reference, disposition: "active" } : reference) };
}

export function videoOneImportCandidates(analysis: H3ImportAnalysis): H3ImportedReference[] {
  if (!analysis.prompt || !/<Video\s+1>/i.test(analysis.prompt)) return [];
  if (analysis.references.some((reference) => reference.kind === "video" && reference.disposition === "active")) return [];
  return analysis.references.filter((reference) => reference.kind === "video" && !reference.connected && reference.disposition === "unused" && Boolean(reference.matchedFileKey));
}

export function useImportAssetAsVideoOne(analysis: H3ImportAnalysis, candidateId: string): H3ImportAnalysis {
  if (!videoOneImportCandidates(analysis).some((candidate) => candidate.id === candidateId)) return analysis;
  return {
    ...analysis,
    references: analysis.references.map((reference) => reference.id === candidateId ? { ...reference, disposition: "active", manualRole: "Video 1" } : reference),
    warnings: [...analysis.warnings, "Video 1 was assigned manually from an unused imported video; the original workflow graph remains unchanged."],
  };
}

export function videoOneSourceCandidates(analysis: H3ImportAnalysis, currentId?: string): H3ImportedReference[] {
  return analysis.references.filter((reference) => reference.kind === "video"
    && !reference.connected
    && Boolean(reference.matchedFileKey)
    && reference.id !== currentId
    && reference.disposition === "unused");
}

export function unassignImportManualRole(analysis: H3ImportAnalysis, candidateId: string): H3ImportAnalysis {
  const candidate = analysis.references.find((reference) => reference.id === candidateId);
  if (!candidate?.manualRole) return analysis;
  return {
    ...analysis,
    references: analysis.references.map((reference) => {
      if (reference.id !== candidateId) return reference;
      const { manualRole: _manualRole, ...rest } = reference;
      return { ...rest, disposition: "unused" };
    }),
    warnings: analysis.warnings.filter((warning) => !/Video 1 was assigned manually/i.test(warning)),
  };
}

export function changeImportManualRoleSource(analysis: H3ImportAnalysis, currentId: string, candidateId: string): H3ImportAnalysis {
  const candidate = analysis.references.find((reference) => reference.id === candidateId);
  if (!candidate || candidate.kind !== "video" || candidate.disposition !== "unused") return analysis;
  const released = unassignImportManualRole(analysis, currentId);
  return useImportAssetAsVideoOne(released, candidateId);
}

export function addExactDuplicateWarnings(analysis: H3ImportAnalysis, fingerprints: H3ImportFingerprint[]): H3ImportAnalysis {
  const groups = new Map<string, H3ImportFingerprint[]>();
  for (const fingerprint of fingerprints) {
    const key = `${fingerprint.size}:${fingerprint.sha256.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), fingerprint]);
  }
  const duplicateWarnings = Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => `Possible exact duplicate: ${group.map((item) => item.name).join(", ")} have identical size and SHA-256. No files were removed.`);
  if (!duplicateWarnings.length) return analysis;
  return { ...analysis, warnings: [...analysis.warnings, ...duplicateWarnings.filter((warning) => !analysis.warnings.includes(warning))] };
}

function resolveImportSource(analysis: H3ImportAnalysis, targetId: string, fileKey: string, sourceName: string, candidateId?: string): H3ImportAnalysis {
  const target = analysis.references.find((reference) => reference.id === targetId);
  if (!target) return analysis;
  return {
    ...analysis,
    references: analysis.references.map((reference) => {
      if (reference.id === targetId) return { ...reference, matchedFileKey: fileKey, resolvedSourceName: sourceName, ...(candidateId ? { resolvedFromReferenceId: candidateId } : {}), missing: false };
      if (candidateId && reference.id === candidateId) return { ...reference, disposition: "resolved", resolvedByReferenceId: targetId };
      return reference;
    }),
    warnings: analysis.warnings.filter((warning) => !(warning.includes(target.sourceName) && /missing/i.test(warning))),
  };
}

export function analyzeImportSet(files: H3ImportFile[], jsonSources: Array<{ fileName: string; value: unknown }>): H3ImportAnalysis {
  const knownWorkflow = jsonSources
    .map((source) => ({ source, graph: asWorkflowGraph(source.value) }))
    .find((candidate) => candidate.graph);
  if (knownWorkflow?.graph) return analyzeComfyWorkflow(knownWorkflow.graph, files, knownWorkflow.source.fileName);

  const project = jsonSources.find((source) => isSnarkRouteProject(source.value));
  if (project) return analyzeSnarkRouteProject(project.value as Record<string, unknown>, files, project.fileName);

  const media = files.filter((file) => mediaKindForImportFile(file));
  const warnings = jsonSources.length
    ? ["JSON was preserved as an import source but was not recognized as a supported workflow/config format. It was not treated as a prompt or executed."]
    : [];
  return {
    sourceType: jsonSources.length ? "unknown_json" : "loose_files",
    workflowName: jsonSources.length ? "Unrecognized JSON + media set" : "Loose media set",
    generation: {},
    contextIr: { detected: false, exactCompatibility: false },
    stages: { promptEnhanceDetected: false, regenerate2kDetected: false, saveTextDetected: false, saveVideoCount: 0 },
    references: media.map((file, index) => ({
      id: `loose-${index}-${file.key}`,
      kind: mediaKindForImportFile(file)!,
      sourceName: file.name,
      connected: true,
      classification: "loose",
      matchedFileKey: file.key,
      missing: false,
      disposition: "active",
    })),
    warnings,
    metadata: { jsonFileNames: jsonSources.map((source) => source.fileName) },
  };
}

export function analyzeComfyWorkflow(graph: WorkflowGraph, files: H3ImportFile[] = [], workflowFileName?: string): H3ImportAnalysis {
  const entries = Object.entries(graph);
  const generationEntry = entries.find(([, node]) => isGenerationNode(node));
  const generationNode = generationEntry?.[1];
  const generationInputs = generationNode?.inputs ?? {};
  const connectedMedia = new Map<string, string>();

  for (const [inputName, value] of Object.entries(generationInputs)) {
    if (!/reference|image|video|audio/i.test(inputName)) continue;
    for (const mediaNodeId of traceMediaNodes(value, graph)) {
      if (!connectedMedia.has(mediaNodeId)) connectedMedia.set(mediaNodeId, inputName);
    }
  }

  const allMedia = entries.filter(([, node]) => mediaKindForNode(node));
  const workflowReferences = allMedia.map(([nodeId, node], index): H3ImportedReference => {
    const kind = mediaKindForNode(node)!;
    const sourceName = sourceNameForNode(node, kind) ?? `${kind}-${nodeId}`;
    const connectionInput = connectedMedia.get(nodeId);
    const matched = matchReferencedFile(sourceName, files);
    return {
      id: `node-${nodeId}-${index}`,
      nodeId,
      kind,
      sourceName,
      connected: Boolean(connectionInput),
      ...(connectionInput ? { connectionInput } : {}),
      classification: connectionInput ? "reference" : isPreviousStageOutput(nodeId, graph) ? "previous_stage_output" : "orphaned",
      ...(matched ? { matchedFileKey: matched.key } : {}),
      missing: Boolean(connectionInput) && !matched,
      disposition: connectionInput ? "active" : "unused",
    };
  }).sort(referenceOrder);
  const matchedFileKeys = new Set(workflowReferences.map((reference) => reference.matchedFileKey).filter((key): key is string => Boolean(key)));
  const extraFiles = files.filter((file) => mediaKindForImportFile(file) && !matchedFileKeys.has(file.key)).map((file, index): H3ImportedReference => ({
    id: `file-${index}-${file.key}`,
    kind: mediaKindForImportFile(file)!,
    sourceName: file.relativePath || file.name,
    connected: false,
    classification: "orphaned",
    matchedFileKey: file.key,
    missing: false,
    disposition: "unused",
  }));
  const references = [...workflowReferences, ...extraFiles];

  const prompt = findPrompt(generationInputs["model.prompt"] ?? generationInputs.prompt, graph)
    ?? entries.map(([, node]) => node.class_type === "PrimitiveStringMultiline" ? stringValue(node.inputs?.value) : undefined).find(Boolean);
  const contextIrNode = entries.find(([, node]) => /ContextIR/i.test(node.class_type ?? ""));
  const promptEnhanceSwitch = booleanByTitle(graph, /Prompt Enhance/i);
  const regenerate2k = entries.some(([, node]) => /Regenerate/i.test(node.class_type ?? ""));
  const regenerate2kSwitch = booleanByTitle(graph, /(?:Upscale|2K)/i);
  const warnings: string[] = [];
  const connectedVideos = references.filter((reference) => reference.kind === "video" && reference.connected);
  const orphanedVideos = references.filter((reference) => reference.kind === "video" && !reference.connected);
  if (prompt && /<Video\s+1>/i.test(prompt) && !connectedVideos.length && orphanedVideos.length) {
    warnings.push("Workflow contains a video asset referenced in the text as <Video 1>, but the video node is not connected to the generation graph.");
  }
  if (contextIrNode) {
    warnings.push("Context IR / Prompt Enhance metadata was imported, but SnarkRoute ContextProcessor is not assumed to be an exact equivalent of the source workflow implementation.");
  }
  for (const reference of references.filter((item) => item.connected && item.missing)) {
    warnings.push(`${importReferenceLabel(reference, references)} uses ${reference.sourceName}, but the source file is missing.`);
  }

  return {
    sourceType: "comfyui_api",
    workflowName: generationNode?._meta?.title ?? generationNode?.class_type ?? "Known node-graph workflow",
    ...(workflowFileName ? { workflowFileName } : {}),
    ...(stringValue(generationInputs.model) ? { model: stringValue(generationInputs.model) } : {}),
    ...(prompt ? { prompt } : {}),
    generation: {
      ...(stringValue(generationInputs["model.resolution"] ?? generationInputs.resolution) ? { resolution: stringValue(generationInputs["model.resolution"] ?? generationInputs.resolution) } : {}),
      ...(stringValue(generationInputs["model.ratio"] ?? generationInputs.ratio) ? { ratio: stringValue(generationInputs["model.ratio"] ?? generationInputs.ratio) } : {}),
      ...(finiteNumber(generationInputs["model.duration"] ?? generationInputs.duration) !== undefined ? { duration: finiteNumber(generationInputs["model.duration"] ?? generationInputs.duration) } : {}),
      ...(finiteNumber(generationInputs.seed) !== undefined ? { seed: finiteNumber(generationInputs.seed) } : {}),
      ...(stringValue(generationInputs["model.prompt_expansion_mode"] ?? generationInputs.prompt_expansion_mode) ? { promptExpansionMode: stringValue(generationInputs["model.prompt_expansion_mode"] ?? generationInputs.prompt_expansion_mode) } : {}),
      ...(stringValue(generationInputs["model.reference_detail"] ?? generationInputs.reference_detail) ? { referenceDetail: stringValue(generationInputs["model.reference_detail"] ?? generationInputs.reference_detail) } : {}),
      ...(typeof generationInputs.watermark === "boolean" ? { watermark: generationInputs.watermark } : {}),
    },
    contextIr: { detected: Boolean(contextIrNode), ...(promptEnhanceSwitch !== undefined ? { enabled: promptEnhanceSwitch } : {}), exactCompatibility: false },
    stages: {
      promptEnhanceDetected: promptEnhanceSwitch !== undefined || Boolean(contextIrNode),
      ...(promptEnhanceSwitch !== undefined ? { promptEnhanceEnabled: promptEnhanceSwitch } : {}),
      regenerate2kDetected: regenerate2k,
      ...(regenerate2kSwitch !== undefined ? { regenerate2kEnabled: regenerate2kSwitch } : {}),
      saveTextDetected: entries.some(([, node]) => node.class_type === "SaveText"),
      saveVideoCount: entries.filter(([, node]) => node.class_type === "SaveVideo").length,
    },
    references,
    warnings,
    metadata: {
      format: "comfyui_api",
      generationNodeId: generationEntry?.[0],
      generationClassType: generationNode?.class_type,
      contextIrNodeId: contextIrNode?.[0],
      nodeCount: entries.length,
    },
  };
}

function asWorkflowGraph(value: unknown): WorkflowGraph | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return null;
  const nodes = entries.filter(([, candidate]) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && typeof (candidate as WorkflowNode).class_type === "string");
  return nodes.length === entries.length ? value as WorkflowGraph : null;
}

function isSnarkRouteProject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.format === "snarkroute-h3-project" || record.taskFamily === "FL2VA" || record.taskFamily === "Ref2VA";
}

function analyzeSnarkRouteProject(project: Record<string, unknown>, files: H3ImportFile[], workflowFileName: string): H3ImportAnalysis {
  const rawReferences = Array.isArray(project.references) ? project.references : [];
  const references = rawReferences.flatMap((value, index): H3ImportedReference[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const reference = value as Record<string, unknown>;
    const kind = reference.kind === "image" || reference.kind === "video" || reference.kind === "audio" ? reference.kind : null;
    const sourceName = stringValue(reference.filename ?? reference.sourceName);
    if (!kind || !sourceName) return [];
    const matched = matchReferencedFile(sourceName, files);
    return [{ id: `project-${index}`, kind, sourceName, connected: true, classification: "reference", ...(matched ? { matchedFileKey: matched.key } : {}), missing: !matched, disposition: "active" }];
  });
  const generation = project.generation && typeof project.generation === "object" && !Array.isArray(project.generation) ? project.generation as Record<string, unknown> : {};
  return {
    sourceType: "snarkroute_project",
    workflowName: stringValue(project.name) ?? "SnarkRoute H3 project",
    workflowFileName,
    ...(stringValue(project.model) ? { model: stringValue(project.model) } : {}),
    ...(stringValue(project.prompt) ? { prompt: stringValue(project.prompt) } : {}),
    ...(stringValue(project.contextInstruction) ? { contextInstruction: stringValue(project.contextInstruction) } : {}),
    generation: {
      ...(stringValue(generation.resolution) ? { resolution: stringValue(generation.resolution) } : {}),
      ...(stringValue(generation.ratio) ? { ratio: stringValue(generation.ratio) } : {}),
      ...(finiteNumber(generation.duration) !== undefined ? { duration: finiteNumber(generation.duration) } : {}),
      ...(finiteNumber(generation.seed) !== undefined ? { seed: finiteNumber(generation.seed) } : {}),
    },
    contextIr: { detected: false, exactCompatibility: false },
    stages: { promptEnhanceDetected: false, regenerate2kDetected: false, saveTextDetected: false, saveVideoCount: 0 },
    references,
    warnings: references.filter((reference) => reference.missing).map((reference) => `${reference.sourceName} is missing from the imported set.`),
    metadata: { format: "snarkroute-h3-project", taskFamily: project.taskFamily, modifiers: project.modifiers, stages: project.stages },
  };
}

function isGenerationNode(node: WorkflowNode): boolean {
  const classType = node.class_type ?? "";
  if (/ContextIR|Regenerate|Save/i.test(classType)) return false;
  return /Minimax.*(?:Reference|Generate|Hailuo)/i.test(classType) || Object.keys(node.inputs ?? {}).some((key) => /^model\.reference_images\./.test(key));
}

function traceMediaNodes(value: unknown, graph: WorkflowGraph, seen = new Set<string>()): string[] {
  const link = workflowLink(value);
  if (!link || seen.has(link)) return [];
  seen.add(link);
  const node = graph[link];
  if (!node) return [];
  if (mediaKindForNode(node)) return [link];
  return Object.values(node.inputs ?? {}).flatMap((input) => traceMediaNodes(input, graph, new Set(seen)));
}

function workflowLink(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 2 || !["string", "number"].includes(typeof value[0]) || typeof value[1] !== "number") return null;
  return String(value[0]);
}

function mediaKindForNode(node: WorkflowNode): H3ImportMediaKind | null {
  const classType = node.class_type ?? "";
  if (/LoadImage/i.test(classType)) return "image";
  if (/LoadVideo/i.test(classType)) return "video";
  if (/LoadAudio/i.test(classType)) return "audio";
  return null;
}

function sourceNameForNode(node: WorkflowNode, kind: H3ImportMediaKind): string | undefined {
  const inputs = node.inputs ?? {};
  const candidates = kind === "image" ? [inputs.image, inputs.file, inputs.filename] : kind === "video" ? [inputs.video, inputs.file, inputs.filename] : [inputs.audio, inputs.file, inputs.filename];
  return candidates.map(stringValue).find(Boolean);
}

function matchReferencedFile(sourceName: string, files: H3ImportFile[]): H3ImportFile | undefined {
  const normalizedSource = normalizePath(sourceName);
  const exactPath = files.filter((file) => normalizePath(file.relativePath ?? file.name) === normalizedSource);
  if (exactPath.length === 1) return exactPath[0];
  const sourceBase = normalizedSource.split("/").pop();
  const exactName = files.filter((file) => normalizePath(file.name).split("/").pop() === sourceBase);
  if (exactName.length === 1) return exactName[0];
  const sourceStem = sourceBase?.replace(/\.[^.]+$/, "");
  if (sourceStem && /^[a-f0-9]{32,128}$/i.test(sourceStem)) {
    const hashName = files.filter((file) => normalizePath(file.name).split("/").pop()?.replace(/\.[^.]+$/, "") === sourceStem);
    if (hashName.length === 1) return hashName[0];
  }
  return undefined;
}

function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(); }

function findPrompt(value: unknown, graph: WorkflowGraph, seen = new Set<string>()): string | undefined {
  const link = workflowLink(value);
  if (!link || seen.has(link)) return undefined;
  seen.add(link);
  const node = graph[link];
  if (!node) return undefined;
  if (node.class_type === "PrimitiveStringMultiline") return stringValue(node.inputs?.value);
  const prompts = Object.values(node.inputs ?? {}).map((input) => findPrompt(input, graph, new Set(seen))).filter((candidate): candidate is string => Boolean(candidate));
  return prompts.sort((left, right) => right.length - left.length)[0];
}

function booleanByTitle(graph: WorkflowGraph, titlePattern: RegExp): boolean | undefined {
  const entry = Object.values(graph).find((node) => node.class_type === "PrimitiveBoolean" && titlePattern.test(node._meta?.title ?? ""));
  return typeof entry?.inputs?.value === "boolean" ? entry.inputs.value : undefined;
}

function isPreviousStageOutput(nodeId: string, graph: WorkflowGraph): boolean {
  return Object.values(graph).some((node) => /Regenerate|Generate/i.test(node.class_type ?? "") && Object.values(node.inputs ?? {}).some((value) => workflowLink(value) === nodeId));
}

function referenceOrder(left: H3ImportedReference, right: H3ImportedReference): number {
  if (left.connected !== right.connected) return left.connected ? -1 : 1;
  const leftIndex = Number(left.connectionInput?.match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const rightIndex = Number(right.connectionInput?.match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return leftIndex - rightIndex;
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
