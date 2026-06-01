import type { ModelProfile } from "./model-registry";

export type DialogueMessageRole = "user" | "assistant" | "system" | "tool";
export type DialogueOutputType = "text" | "image" | "json" | "file";
export type DialogueOutputStatus = "draft" | "selected" | "locked";

export type DialogueContentPart =
  | { type: "text"; text: string; chipBackgroundAssetRef?: string }
  | { type: "image"; assetRef: string; alt?: string }
  | { type: "file"; assetRef: string; filename?: string }
  | { type: "json"; value: unknown };

export interface DialogueMessage {
  id: string;
  role: DialogueMessageRole;
  content: DialogueContentPart[];
  createdAt: string;
  modelProfileId?: string;
  actualProviderId?: string;
  actualModelId?: string;
  params?: Record<string, unknown>;
  costEstimate?: number;
  pinned?: boolean;
  selectedAsOutput?: boolean;
}

export interface DialogueSelectedOutput {
  id: string;
  name: string;
  type: DialogueOutputType;
  sourceMessageId?: string;
  sourceAssetId?: string;
  value?: unknown;
  assetRef?: string;
  status: DialogueOutputStatus;
}

export interface ConversationCapsule {
  id: string;
  sourceNodeId: string;
  conversationId: string;
  parentConversationIds?: string[];
  compactSummary: string;
  decisions: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  pinnedArtifacts: unknown[];
  selectedOutputs: unknown[];
  createdAt: string;
}

export interface DialogueWorkbenchState {
  conversationId: string;
  defaultModelProfileId?: string;
  agentPresetId?: string;
  messages: DialogueMessage[];
  selectedOutputs: DialogueSelectedOutput[];
  parentConversationCapsules?: ConversationCapsule[];
}

export interface DialogueWorkbenchInputSummary {
  id: string;
  type: "text" | "image" | "json" | "file" | "conversation_context";
  value: unknown;
}

export interface DialogueWorkbenchOutputs {
  conversation_text: string;
  conversation_json: Record<string, unknown>;
  conversation_capsule: ConversationCapsule;
  [port: string]: unknown;
}

export const DIALOGUE_WORKBENCH_SYSTEM_OUTPUTS = [
  { id: "conversation_text", kind: "text", label: "conversation_text" },
  { id: "conversation_json", kind: "json", label: "conversation_json" },
  { id: "conversation_capsule", kind: "conversation_context", label: "conversation_capsule" }
] as const;

export function createDialogueWorkbenchState(seed: { nodeId: string; now?: string; defaultModelProfileId?: string } = { nodeId: "dialogue" }): DialogueWorkbenchState {
  const now = seed.now ?? new Date().toISOString();
  return {
    conversationId: `conversation_${seed.nodeId}_${stableIdPart(now)}`,
    defaultModelProfileId: seed.defaultModelProfileId ?? "text.default",
    messages: [],
    selectedOutputs: []
  };
}

export function normalizeDialogueWorkbenchState(input: unknown, fallback: { nodeId: string; defaultModelProfileId?: string }): DialogueWorkbenchState {
  const record = isRecord(input) ? input : {};
  const fallbackState = createDialogueWorkbenchState({ nodeId: fallback.nodeId, defaultModelProfileId: fallback.defaultModelProfileId });
  return {
    conversationId: stringField(record.conversationId) || fallbackState.conversationId,
    defaultModelProfileId: stringField(record.defaultModelProfileId) || fallback.defaultModelProfileId,
    agentPresetId: stringField(record.agentPresetId) || undefined,
    messages: Array.isArray(record.messages) ? record.messages.flatMap(normalizeMessage) : [],
    selectedOutputs: Array.isArray(record.selectedOutputs) ? record.selectedOutputs.flatMap(normalizeSelectedOutput) : [],
    parentConversationCapsules: Array.isArray(record.parentConversationCapsules) ? record.parentConversationCapsules.flatMap(normalizeConversationCapsule) : undefined
  };
}

export function buildDialogueWorkbenchOutputs(options: {
  nodeId: string;
  nodeTitle?: string;
  state: DialogueWorkbenchState;
  inputs?: Record<string, unknown>;
  modelProfiles?: ModelProfile[];
  now?: string;
}): DialogueWorkbenchOutputs {
  const inputSummaries = summarizeDialogueInputs(options.inputs ?? {});
  const conversation_json = generateConversationJson({
    nodeId: options.nodeId,
    nodeTitle: options.nodeTitle,
    state: options.state,
    inputs: inputSummaries
  });
  const conversation_capsule = generateConversationCapsule({
    nodeId: options.nodeId,
    state: options.state,
    now: options.now
  });
  const conversation_text = generateConversationText({
    nodeTitle: options.nodeTitle ?? options.nodeId,
    state: options.state,
    inputs: inputSummaries,
    modelProfiles: options.modelProfiles ?? []
  });
  const selected = Object.fromEntries(
    options.state.selectedOutputs.map((output) => [output.id, selectedOutputValue(output)])
  );
  return {
    conversation_text,
    conversation_json,
    conversation_capsule,
    ...selected
  };
}

export function generateConversationText(options: {
  nodeTitle: string;
  state: DialogueWorkbenchState;
  inputs: DialogueWorkbenchInputSummary[];
  modelProfiles: ModelProfile[];
}): string {
  const profileById = new Map(options.modelProfiles.map((profile) => [profile.id, profile]));
  const lines: string[] = [`# Dialogue: ${options.nodeTitle}`, "", "## Inputs", ""];
  if (options.inputs.length === 0) lines.push("- none");
  for (const input of options.inputs) lines.push(`- ${input.type}: ${inputValuePreview(input.value)}`);
  lines.push("", "## Messages", "");
  if (options.state.messages.length === 0) lines.push("_No messages yet._", "");
  for (const message of options.state.messages) {
    lines.push(`### ${capitalize(message.role)}`);
    if (message.role === "assistant") {
      const profile = message.modelProfileId ? profileById.get(message.modelProfileId) : undefined;
      const modelLabel = profile ? `${profile.displayName} / ${profile.providerId} / ${profile.modelId}` : [message.modelProfileId, message.actualProviderId, message.actualModelId].filter(Boolean).join(" / ");
      if (modelLabel) lines.push(`Model: ${modelLabel}`);
    }
    if (message.pinned) lines.push("Pinned: yes");
    lines.push(...message.content.map(contentPartToMarkdown), "");
  }
  lines.push("## Selected Outputs", "");
  if (options.state.selectedOutputs.length === 0) lines.push("- none");
  for (const output of options.state.selectedOutputs) {
    const value = output.assetRef ?? inputValuePreview(output.value);
    lines.push(`- ${output.name}: ${value} (${output.status})`);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function generateConversationJson(options: {
  nodeId: string;
  nodeTitle?: string;
  state: DialogueWorkbenchState;
  inputs: DialogueWorkbenchInputSummary[];
}): Record<string, unknown> {
  return {
    conversationId: options.state.conversationId,
    nodeId: options.nodeId,
    nodeTitle: options.nodeTitle,
    defaultModelProfileId: options.state.defaultModelProfileId,
    agentPresetId: options.state.agentPresetId,
    inputs: options.inputs,
    messages: options.state.messages,
    selectedOutputs: options.state.selectedOutputs,
    parentConversationRefs: options.state.parentConversationCapsules?.map((capsule) => ({
      id: capsule.id,
      conversationId: capsule.conversationId,
      sourceNodeId: capsule.sourceNodeId
    })) ?? [],
    parentConversationCapsules: options.state.parentConversationCapsules ?? []
  };
}

export function generateConversationCapsule(options: {
  nodeId: string;
  state: DialogueWorkbenchState;
  now?: string;
}): ConversationCapsule {
  const pinnedMessages = options.state.messages.filter((message) => message.pinned || message.selectedAsOutput);
  const selectedOutputs = options.state.selectedOutputs.filter((output) => output.status === "selected" || output.status === "locked");
  const compactSummary = [
    ...pinnedMessages.map((message) => `${capitalize(message.role)}: ${message.content.map(contentPartPlainText).filter(Boolean).join(" ").trim()}`),
    ...selectedOutputs.map((output) => `${output.name}: ${inputValuePreview(selectedOutputValue(output))}`)
  ].filter(Boolean).join("\n").trim() || "No pinned messages or selected outputs yet.";
  return {
    id: `capsule_${options.nodeId}_${stableIdPart(options.state.conversationId)}`,
    sourceNodeId: options.nodeId,
    conversationId: options.state.conversationId,
    parentConversationIds: options.state.parentConversationCapsules?.map((capsule) => capsule.conversationId),
    compactSummary,
    decisions: selectedOutputs.map((output) => `${output.name} selected as ${output.type}`),
    assumptions: [],
    unresolvedQuestions: [],
    pinnedArtifacts: pinnedMessages.map((message) => ({ messageId: message.id, role: message.role, content: message.content })),
    selectedOutputs,
    createdAt: options.now ?? new Date().toISOString()
  };
}

export function summarizeDialogueInputs(inputs: Record<string, unknown>): DialogueWorkbenchInputSummary[] {
  return Object.entries(inputs).flatMap(([id, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.map((entry, index) => ({ id: values.length > 1 ? `${id}_${index + 1}` : id, type: inferInputType(id, entry), value: entry }));
  });
}

export function selectedOutputValue(output: DialogueSelectedOutput): unknown {
  if (output.assetRef) return output.assetRef;
  return output.value ?? null;
}

function normalizeMessage(input: unknown): DialogueMessage[] {
  if (!isRecord(input)) return [];
  const role = ["user", "assistant", "system", "tool"].includes(String(input.role)) ? String(input.role) as DialogueMessageRole : "user";
  const content = Array.isArray(input.content) ? input.content.flatMap(normalizeContentPart) : [];
  return [{
    id: stringField(input.id) || `message_${Date.now()}`,
    role,
    content,
    createdAt: stringField(input.createdAt) || new Date().toISOString(),
    modelProfileId: stringField(input.modelProfileId) || undefined,
    actualProviderId: stringField(input.actualProviderId) || undefined,
    actualModelId: stringField(input.actualModelId) || undefined,
    params: isRecord(input.params) ? input.params : undefined,
    costEstimate: typeof input.costEstimate === "number" ? input.costEstimate : undefined,
    pinned: Boolean(input.pinned),
    selectedAsOutput: Boolean(input.selectedAsOutput)
  }];
}

function normalizeContentPart(input: unknown): DialogueContentPart[] {
  if (!isRecord(input)) return [];
  if (input.type === "text") return [{ type: "text", text: String(input.text ?? ""), chipBackgroundAssetRef: stringField(input.chipBackgroundAssetRef) || undefined }];
  if (input.type === "image" && typeof input.assetRef === "string") return [{ type: "image", assetRef: input.assetRef, alt: stringField(input.alt) || undefined }];
  if (input.type === "file" && typeof input.assetRef === "string") return [{ type: "file", assetRef: input.assetRef, filename: stringField(input.filename) || undefined }];
  if (input.type === "json") return [{ type: "json", value: input.value }];
  return [];
}

function normalizeSelectedOutput(input: unknown): DialogueSelectedOutput[] {
  if (!isRecord(input)) return [];
  const status = ["draft", "selected", "locked"].includes(String(input.status)) ? String(input.status) as DialogueOutputStatus : "draft";
  const type = ["text", "image", "json", "file"].includes(String(input.type)) ? String(input.type) as DialogueOutputType : "text";
  return [{
    id: stringField(input.id) || `output_${Date.now()}`,
    name: stringField(input.name) || stringField(input.id) || "output",
    type,
    sourceMessageId: stringField(input.sourceMessageId) || undefined,
    sourceAssetId: stringField(input.sourceAssetId) || undefined,
    value: input.value,
    assetRef: stringField(input.assetRef) || undefined,
    status
  }];
}

function normalizeConversationCapsule(input: unknown): ConversationCapsule[] {
  if (!isRecord(input)) return [];
  return [{
    id: stringField(input.id) || `capsule_${Date.now()}`,
    sourceNodeId: stringField(input.sourceNodeId) || "",
    conversationId: stringField(input.conversationId) || "",
    parentConversationIds: Array.isArray(input.parentConversationIds) ? input.parentConversationIds.filter((value): value is string => typeof value === "string") : undefined,
    compactSummary: stringField(input.compactSummary),
    decisions: stringArray(input.decisions),
    assumptions: stringArray(input.assumptions),
    unresolvedQuestions: stringArray(input.unresolvedQuestions),
    pinnedArtifacts: Array.isArray(input.pinnedArtifacts) ? input.pinnedArtifacts : [],
    selectedOutputs: Array.isArray(input.selectedOutputs) ? input.selectedOutputs : [],
    createdAt: stringField(input.createdAt) || new Date().toISOString()
  }];
}

function inferInputType(id: string, value: unknown): DialogueWorkbenchInputSummary["type"] {
  if (id === "context" || (isRecord(value) && typeof value.compactSummary === "string" && typeof value.conversationId === "string")) return "conversation_context";
  if (id.toLowerCase().includes("image") || (isRecord(value) && typeof value.mimeType === "string" && value.mimeType.startsWith("image/"))) return "image";
  if (id.toLowerCase().includes("file") || (isRecord(value) && typeof value.filename === "string")) return "file";
  if (typeof value === "string" || (isRecord(value) && typeof value.text === "string")) return "text";
  return "json";
}

function contentPartToMarkdown(part: DialogueContentPart): string {
  if (part.type === "text") return part.text || "_empty_";
  if (part.type === "image") return `![${part.alt ?? "image"}](${part.assetRef})`;
  if (part.type === "file") return `[${part.filename ?? "file"}](${part.assetRef})`;
  return `\`\`\`json\n${JSON.stringify(part.value, null, 2)}\n\`\`\``;
}

function contentPartPlainText(part: DialogueContentPart): string {
  if (part.type === "text") return part.text;
  if (part.type === "image") return `image:${part.assetRef}`;
  if (part.type === "file") return `file:${part.assetRef}`;
  return JSON.stringify(part.value);
}

function inputValuePreview(value: unknown): string {
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  if (isRecord(value) && typeof value.text === "string") return inputValuePreview(value.text);
  if (isRecord(value) && typeof value.path === "string") return value.path;
  if (isRecord(value) && typeof value.assetRef === "string") return value.assetRef;
  return JSON.stringify(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function stableIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || Math.random().toString(16).slice(2);
}
