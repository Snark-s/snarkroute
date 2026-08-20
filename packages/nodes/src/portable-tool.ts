export const PORTABLE_TOOL_SCHEMA_VERSION = "1.0";

export const PORTABLE_JOB_STATES = [
  "queued",
  "starting_provider",
  "loading_model",
  "generating",
  "generating_768p",
  "regenerating_2k",
  "downloading",
  "completed",
  "failed",
  "cancelled"
] as const;

export type PortableJobState = typeof PORTABLE_JOB_STATES[number];
export type PortableToolHost = "boojumroute" | "after_effects" | "photoshop";
export type PortableToolValueType =
  | "text" | "multiline_text" | "number" | "integer" | "boolean" | "select"
  | "image" | "images" | "video" | "videos" | "audio" | "mask" | "seed"
  | "duration" | "resolution" | "host_selection" | "host_active_layer"
  | "host_current_frame" | "host_work_area";
export type PortableToolInputSource =
  | "manual" | "upload" | "host_selection" | "host_active_layer" | "host_current_frame"
  | "host_first_frame" | "host_last_frame" | "host_work_area" | "photoshop_selection";
export type PortableToolResultPlacement =
  | "download" | "new_artifact" | "project_item" | "replace_placeholder" | "new_layer"
  | "selection_layer" | "next_stage";

export interface PortableToolField {
  id: string;
  label?: string;
  description?: string;
  type: PortableToolValueType;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string | number | boolean; label?: string }>;
  multiple?: boolean;
  minItems?: number;
  maxItems?: number;
  acceptedMimes?: string[];
  source?: PortableToolInputSource;
  hostSources?: Partial<Record<PortableToolHost, PortableToolInputSource>>;
  includeMask?: boolean;
  includeComposite?: boolean;
  contextPadding?: number;
}

export interface PortableToolOutput extends Omit<PortableToolField, "source" | "hostSources"> {
  placement: PortableToolResultPlacement;
  hostPlacements?: Partial<Record<PortableToolHost, PortableToolResultPlacement>>;
  clipToSelection?: boolean;
  allowSelection?: boolean;
}

export interface PortableToolHostContract {
  host: PortableToolHost;
  sources: PortableToolInputSource[];
  placements: PortableToolResultPlacement[];
  capabilities?: string[];
}

export interface PortableToolSchema {
  schemaVersion: string;
  id: string;
  title: string;
  description?: string;
  version: string;
  action: { kind: "node" | "endpoint"; value: string };
  inputs: PortableToolField[];
  outputs: PortableToolOutput[];
  params?: PortableToolField[];
  hosts: PortableToolHostContract[];
  job: {
    states: PortableJobState[];
    cancellable: boolean;
    retryable: boolean;
    selectableResults: boolean;
  };
  pricing?: {
    currency?: string;
    unit?: string;
    estimateEndpoint?: string;
    configuredRate?: number;
    source?: string;
    effectiveDate?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface PortableToolDiagnostic {
  path: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface PortableToolValidationResult {
  ok: boolean;
  tool?: PortableToolSchema;
  issues: PortableToolDiagnostic[];
}

type LegacyManifest = {
  id?: unknown;
  title?: unknown;
  version?: unknown;
  description?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  params?: unknown;
  canvasAction?: unknown;
  tool?: unknown;
  generatedWith?: unknown;
};

const valueTypes = new Set<string>([
  "text", "multiline_text", "number", "integer", "boolean", "select", "image", "images", "video",
  "videos", "audio", "mask", "seed", "duration", "resolution", "host_selection", "host_active_layer",
  "host_current_frame", "host_work_area"
]);
const inputSources = new Set<string>(["manual", "upload", "host_selection", "host_active_layer", "host_current_frame", "host_first_frame", "host_last_frame", "host_work_area", "photoshop_selection"]);
const placements = new Set<string>(["download", "new_artifact", "project_item", "replace_placeholder", "new_layer", "selection_layer", "next_stage"]);
const hosts = new Set<string>(["boojumroute", "after_effects", "photoshop"]);
const jobStates = new Set<string>(PORTABLE_JOB_STATES);
const idPattern = /^[A-Za-z0-9._-]+$/;
const secretPattern = /(?:api[_-]?key|access[_-]?token|secret|password|credential)/i;

export function validatePortableToolSchema(value: unknown): PortableToolValidationResult {
  const issues: PortableToolDiagnostic[] = [];
  if (!isRecord(value)) return invalid("<root>", "tool.object", "tool must be a JSON object.");
  requiredString(value.schemaVersion, "schemaVersion", "tool.schema_version", issues);
  const id = requiredString(value.id, "id", "tool.id", issues);
  if (id && !idPattern.test(id)) error(issues, "id", "tool.id_format", "Tool id must use letters, numbers, dots, dashes, or underscores.");
  requiredString(value.title, "title", "tool.title", issues);
  requiredString(value.version, "version", "tool.version", issues);
  validateAction(value.action, issues);
  validateFields(value.inputs, "inputs", true, issues);
  validateOutputs(value.outputs, issues);
  if (value.params !== undefined) validateFields(value.params, "params", false, issues);
  validateHosts(value.hosts, issues);
  validateJob(value.job, issues);
  validatePricing(value.pricing, issues);
  validateSecretExposure(value, issues);
  validateHostCoverage(value, issues);
  try { JSON.stringify(value); } catch { error(issues, "<root>", "tool.not_serializable", "Tool schema must be JSON serializable."); }
  return issues.some((issue) => issue.severity === "error") ? { ok: false, issues } : { ok: true, tool: value as unknown as PortableToolSchema, issues };
}

export function portableToolFromManifest(manifest: LegacyManifest): PortableToolValidationResult & { source: "explicit" | "legacy" | "none" } {
  if (manifest.tool !== undefined) {
    const validation = validatePortableToolSchema(manifest.tool);
    const issues = [...validation.issues, ...validateToolManifestMappings(manifest, validation.tool)];
    return issues.some((issue) => issue.severity === "error") ? { ok: false, issues, source: "explicit" } : { ...validation, issues, source: "explicit" };
  }
  const migrated = migrateLegacyCanvasAction(manifest);
  if (!migrated) return { ok: false, issues: [{ path: "canvasAction", code: "tool.not_published", message: "Node is not published as a tool.", severity: "warning" }], source: "none" };
  const validation = validatePortableToolSchema(migrated);
  const issues = [...validation.issues, ...validateToolManifestMappings(manifest, validation.tool)];
  return issues.some((issue) => issue.severity === "error") ? { ok: false, issues, source: "legacy" } : { ...validation, issues, source: "legacy" };
}

export function migrateLegacyCanvasAction(manifest: LegacyManifest): PortableToolSchema | null {
  if (!isRecord(manifest.canvasAction) || manifest.canvasAction.enabled !== true) return null;
  const id = stringValue(manifest.id);
  const title = stringValue(manifest.canvasAction.title) || stringValue(manifest.title);
  const version = stringValue(manifest.version);
  if (!id || !title || !version) return null;
  const inputs = arrayRecords(manifest.inputs).map((port) => legacyField(port, true));
  const outputs = arrayRecords(manifest.outputs).map((port) => ({ ...legacyField(port, false), placement: "new_artifact" as const, allowSelection: true }));
  const params = arrayRecords(manifest.params).map((param) => legacyField(param, false));
  return {
    schemaVersion: PORTABLE_TOOL_SCHEMA_VERSION,
    id,
    title,
    description: stringValue(manifest.canvasAction.description) || stringValue(manifest.description),
    version,
    action: { kind: "node", value: id },
    inputs,
    outputs,
    params,
    hosts: [{ host: "boojumroute", sources: unique(inputs.map((input) => input.source ?? "manual")), placements: ["new_artifact", "next_stage"], capabilities: ["legacy_canvas_action"] }],
    job: { states: [...PORTABLE_JOB_STATES], cancellable: false, retryable: true, selectableResults: outputs.length > 1 },
    metadata: { migratedFrom: "canvasAction", surface: stringValue(manifest.canvasAction.surface) || "legacy" }
  };
}

function validateAction(value: unknown, issues: PortableToolDiagnostic[]): void {
  if (!isRecord(value)) return error(issues, "action", "tool.action", "action must be an object.");
  if (value.kind !== "node" && value.kind !== "endpoint") error(issues, "action.kind", "tool.action_kind", 'action.kind must be "node" or "endpoint".');
  const actionValue = requiredString(value.value, "action.value", "tool.action_value", issues);
  if (value.kind === "endpoint" && actionValue && (!actionValue.startsWith("/api/") || actionValue.includes(".."))) error(issues, "action.value", "tool.endpoint", "Tool endpoints must be relative /api/ paths without traversal.");
}

function validateFields(value: unknown, path: "inputs" | "params", requireSource: boolean, issues: PortableToolDiagnostic[]): void {
  if (!Array.isArray(value)) return error(issues, path, "tool.fields", `${path} must be an array.`);
  const seen = new Set<string>();
  value.forEach((field, index) => {
    const at = `${path}.${index}`;
    if (!isRecord(field)) return error(issues, at, "tool.field", "Tool field must be an object.");
    const id = requiredString(field.id, `${at}.id`, "tool.field_id", issues);
    if (id && seen.has(id)) error(issues, `${at}.id`, "tool.duplicate_field", `Duplicate ${path} id "${id}".`);
    seen.add(id);
    validateField(field, at, requireSource, issues);
  });
}

function validateOutputs(value: unknown, issues: PortableToolDiagnostic[]): void {
  if (!Array.isArray(value) || value.length === 0) return error(issues, "outputs", "tool.outputs", "Tool must declare at least one output.");
  const seen = new Set<string>();
  value.forEach((field, index) => {
    const at = `outputs.${index}`;
    if (!isRecord(field)) return error(issues, at, "tool.output", "Tool output must be an object.");
    const id = requiredString(field.id, `${at}.id`, "tool.field_id", issues);
    if (id && seen.has(id)) error(issues, `${at}.id`, "tool.duplicate_field", `Duplicate output id "${id}".`);
    seen.add(id);
    validateField(field, at, false, issues);
    if (!placements.has(String(field.placement))) error(issues, `${at}.placement`, "tool.output_placement", "Output placement is required and must be supported.");
    if (field.hostPlacements !== undefined && !isRecord(field.hostPlacements)) error(issues, `${at}.hostPlacements`, "tool.host_placement", "hostPlacements must be an object.");
    if (isRecord(field.hostPlacements)) Object.entries(field.hostPlacements).forEach(([host, placement]) => { if (!hosts.has(host) || !placements.has(String(placement))) error(issues, `${at}.hostPlacements.${host}`, "tool.host_placement", "Unsupported per-host output placement."); });
  });
}

function validateField(field: Record<string, unknown>, path: string, requireSource: boolean, issues: PortableToolDiagnostic[]): void {
  const type = requiredString(field.type, `${path}.type`, "tool.field_type", issues);
  if (type && !valueTypes.has(type)) error(issues, `${path}.type`, "tool.unsupported_type", `Unsupported tool field type "${type}".`);
  if (field.required !== undefined && typeof field.required !== "boolean") error(issues, `${path}.required`, "tool.required", "required must be boolean.");
  const declaredHostSources = isRecord(field.hostSources) ? Object.entries(field.hostSources) : [];
  if (requireSource && !inputSources.has(String(field.source)) && declaredHostSources.length === 0) error(issues, `${path}.source`, "tool.input_source", "Published inputs must declare a supported generic or per-host source.");
  if (field.source !== undefined && !inputSources.has(String(field.source))) error(issues, `${path}.source`, "tool.input_source", "Unsupported input source.");
  declaredHostSources.forEach(([host, source]) => { if (!hosts.has(host) || !inputSources.has(String(source))) error(issues, `${path}.hostSources.${host}`, "tool.host_source", "Unsupported per-host input source."); });
  for (const key of ["min", "max", "step", "minItems", "maxItems", "contextPadding"] as const) if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key]))) error(issues, `${path}.${key}`, "tool.numeric_constraint", `${key} must be a finite number.`);
  if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) error(issues, path, "tool.range", "min cannot be greater than max.");
  if (typeof field.minItems === "number" && typeof field.maxItems === "number" && field.minItems > field.maxItems) error(issues, path, "tool.item_range", "minItems cannot be greater than maxItems.");
  if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0)) error(issues, `${path}.options`, "tool.select_options", "select fields require options.");
  if (Array.isArray(field.options) && field.default !== undefined && !field.options.some((option) => isRecord(option) && Object.is(option.value, field.default))) error(issues, `${path}.default`, "tool.default_option", "Default value must be one of the declared options.");
  if (field.type === "integer" && field.default !== undefined && !Number.isInteger(field.default)) error(issues, `${path}.default`, "tool.integer_default", "integer default must be an integer.");
  if (typeof field.default === "number" && typeof field.min === "number" && field.default < field.min) error(issues, `${path}.default`, "tool.default_range", "Default value is below min.");
  if (typeof field.default === "number" && typeof field.max === "number" && field.default > field.max) error(issues, `${path}.default`, "tool.default_range", "Default value is above max.");
  if (field.acceptedMimes !== undefined && (!Array.isArray(field.acceptedMimes) || !field.acceptedMimes.every((mime) => typeof mime === "string" && /^[\w.+-]+\/[\w.+*-]+$/.test(mime)))) error(issues, `${path}.acceptedMimes`, "tool.mime", "acceptedMimes must contain valid MIME patterns.");
  if (typeof field.contextPadding === "number" && (field.contextPadding < 0 || field.contextPadding > 1)) error(issues, `${path}.contextPadding`, "tool.context_padding", "contextPadding must be between 0 and 1.");
}

function validateHosts(value: unknown, issues: PortableToolDiagnostic[]): void {
  if (!Array.isArray(value) || value.length === 0) return error(issues, "hosts", "tool.hosts", "Tool must declare at least one host contract.");
  const seen = new Set<string>();
  value.forEach((contract, index) => {
    const at = `hosts.${index}`;
    if (!isRecord(contract)) return error(issues, at, "tool.host", "Host contract must be an object.");
    const host = String(contract.host ?? "");
    if (!hosts.has(host)) error(issues, `${at}.host`, "tool.host_name", "Unsupported tool host.");
    if (seen.has(host)) error(issues, `${at}.host`, "tool.duplicate_host", `Duplicate host contract "${host}".`);
    seen.add(host);
    if (!Array.isArray(contract.sources) || !contract.sources.every((source) => inputSources.has(String(source)))) error(issues, `${at}.sources`, "tool.host_sources", "Host sources must be supported values.");
    if (!Array.isArray(contract.placements) || !contract.placements.every((placement) => placements.has(String(placement)))) error(issues, `${at}.placements`, "tool.host_placements", "Host placements must be supported values.");
  });
}

function validateJob(value: unknown, issues: PortableToolDiagnostic[]): void {
  if (!isRecord(value)) return error(issues, "job", "tool.job", "job capability declaration is required.");
  if (!Array.isArray(value.states) || value.states.length === 0 || !value.states.every((state) => jobStates.has(String(state)))) error(issues, "job.states", "tool.job_states", "job.states must contain supported states.");
  for (const key of ["cancellable", "retryable", "selectableResults"]) if (typeof value[key] !== "boolean") error(issues, `job.${key}`, "tool.job_capability", `${key} must be boolean.`);
}

function validatePricing(value: unknown, issues: PortableToolDiagnostic[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) return error(issues, "pricing", "tool.pricing", "pricing must be an object.");
  if (value.configuredRate !== undefined && (typeof value.configuredRate !== "number" || value.configuredRate < 0 || !Number.isFinite(value.configuredRate))) error(issues, "pricing.configuredRate", "tool.pricing_rate", "configuredRate must be a non-negative finite number.");
  if (value.estimateEndpoint !== undefined && (typeof value.estimateEndpoint !== "string" || !value.estimateEndpoint.startsWith("/api/") || value.estimateEndpoint.includes(".."))) error(issues, "pricing.estimateEndpoint", "tool.pricing_endpoint", "estimateEndpoint must be a relative /api/ path.");
}

function validateHostCoverage(tool: Record<string, unknown>, issues: PortableToolDiagnostic[]): void {
  const contracts = arrayRecords(tool.hosts);
  const supportedSources = new Set(contracts.flatMap((contract) => Array.isArray(contract.sources) ? contract.sources.map(String) : []));
  const supportedPlacements = new Set(contracts.flatMap((contract) => Array.isArray(contract.placements) ? contract.placements.map(String) : []));
  const contractByHost = new Map(contracts.map((contract) => [String(contract.host ?? ""), contract]));
  arrayRecords(tool.inputs).forEach((input, index) => {
    if (typeof input.source === "string" && !supportedSources.has(input.source)) error(issues, `inputs.${index}.source`, "tool.host_source_unavailable", `No declared host supports source "${input.source}".`);
    if (isRecord(input.hostSources)) Object.entries(input.hostSources).forEach(([host, source]) => { const contract = contractByHost.get(host); if (!contract || !Array.isArray(contract.sources) || !contract.sources.map(String).includes(String(source))) error(issues, `inputs.${index}.hostSources.${host}`, "tool.host_source_unavailable", `Host "${host}" does not declare source "${String(source)}".`); });
  });
  arrayRecords(tool.outputs).forEach((output, index) => {
    if (typeof output.placement === "string" && !supportedPlacements.has(output.placement)) error(issues, `outputs.${index}.placement`, "tool.host_placement_unavailable", `No declared host supports placement "${output.placement}".`);
    if (isRecord(output.hostPlacements)) Object.entries(output.hostPlacements).forEach(([host, placement]) => { const contract = contractByHost.get(host); if (!contract || !Array.isArray(contract.placements) || !contract.placements.map(String).includes(String(placement))) error(issues, `outputs.${index}.hostPlacements.${host}`, "tool.host_placement_unavailable", `Host "${host}" does not declare placement "${String(placement)}".`); });
  });
}

function validateSecretExposure(tool: Record<string, unknown>, issues: PortableToolDiagnostic[]): void {
  for (const [group, fields] of [["inputs", tool.inputs], ["params", tool.params]] as const) arrayRecords(fields).forEach((field, index) => {
    if (secretPattern.test(String(field.id ?? ""))) error(issues, `${group}.${index}.id`, "tool.secret_exposure", "Provider credentials cannot be public tool fields.");
  });
  if (containsSecretValue(tool.metadata)) error(issues, "metadata", "tool.secret_exposure", "Tool metadata must not contain secret-shaped values.");
}

function validateToolManifestMappings(manifest: LegacyManifest, tool?: PortableToolSchema): PortableToolDiagnostic[] {
  if (!tool) return [];
  const issues: PortableToolDiagnostic[] = [];
  const manifestInputs = arrayRecords(manifest.inputs).map((port) => String(port.id ?? ""));
  const manifestOutputs = arrayRecords(manifest.outputs).map((port) => String(port.id ?? ""));
  const toolInputs = new Set(tool.inputs.map((field) => field.id));
  const toolOutputs = new Set(tool.outputs.map((field) => field.id));
  manifestInputs.forEach((id, index) => { if (id && !toolInputs.has(id)) error(issues, `inputs.${index}`, "tool.unpublished_input", `Public node input "${id}" is missing from the tool schema.`); });
  manifestOutputs.forEach((id, index) => { if (id && !toolOutputs.has(id)) error(issues, `outputs.${index}`, "tool.unpublished_output", `Public node output "${id}" is missing from the tool schema.`); });
  if (tool.action.kind === "node" && tool.action.value !== String(manifest.id ?? "")) error(issues, "action.value", "tool.node_action_mismatch", "Node action must reference the containing manifest id.");
  const generated = isRecord(manifest.generatedWith) ? manifest.generatedWith : undefined;
  const subroute = generated && isRecord(generated.subroute) ? generated.subroute : undefined;
  const compound = generated && isRecord(generated.compound) ? generated.compound : undefined;
  if (subroute && compound) {
    const nodeIds = new Set(arrayRecords(subroute.nodes).map((node) => String(node.id ?? "")));
    for (const [group, mappings] of [["inputs", compound.inputs], ["outputs", compound.outputs]] as const) arrayRecords(mappings).forEach((mapping, index) => {
      if (!nodeIds.has(String(mapping.nodeId ?? ""))) error(issues, `generatedWith.compound.${group}.${index}.nodeId`, "tool.unresolved_internal_connection", "Published port references a missing internal node.");
    });
  }
  return issues;
}

function legacyField(record: Record<string, unknown>, input: boolean): PortableToolField {
  const legacyType = String(record.type ?? "text");
  const type = legacyType === "string" ? "text" : legacyType === "multiline" ? "multiline_text" : Array.isArray(record.options) && record.options.length ? "select" : valueTypes.has(legacyType) ? legacyType as PortableToolValueType : "text";
  const media = ["image", "images", "video", "videos", "audio", "mask"].includes(type);
  return {
    id: String(record.id ?? ""), type, label: stringValue(record.label), description: stringValue(record.description), required: record.required === true,
    default: record.default, min: numberValue(record.min), max: numberValue(record.max), step: numberValue(record.step),
    options: Array.isArray(record.options) ? record.options.flatMap((option) => isRecord(option) && ["string", "number", "boolean"].includes(typeof option.value) ? [{ value: option.value as string | number | boolean, label: stringValue(option.label) }] : []) : undefined,
    source: input ? media ? "host_selection" : "manual" : undefined,
    multiple: type === "images" || type === "videos",
    acceptedMimes: type === "image" || type === "images" || type === "mask" ? ["image/*"] : type === "video" || type === "videos" ? ["video/*"] : type === "audio" ? ["audio/*"] : undefined
  };
}

function containsSecretValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => secretPattern.test(key) && typeof nested === "string" && nested.length > 0 || containsSecretValue(nested));
}
function invalid(path: string, code: string, message: string): PortableToolValidationResult { return { ok: false, issues: [{ path, code, message, severity: "error" }] }; }
function error(issues: PortableToolDiagnostic[], path: string, code: string, message: string): void { issues.push({ path, code, message, severity: "error" }); }
function requiredString(value: unknown, path: string, code: string, issues: PortableToolDiagnostic[]): string { const result = stringValue(value); if (!result) error(issues, path, code, `${path} is required.`); return result; }
function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function arrayRecords(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter(isRecord) : []; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
