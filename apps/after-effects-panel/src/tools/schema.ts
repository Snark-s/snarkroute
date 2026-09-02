export type PortableToolSource = "manual" | "upload" | "host_selection" | "host_active_layer" | "host_current_frame" | "host_first_frame" | "host_last_frame" | "host_work_area" | "photoshop_selection";
export type PortableToolValueType = "text" | "multiline_text" | "number" | "integer" | "boolean" | "select" | "image" | "images" | "video" | "videos" | "audio" | "mask" | "seed" | "duration" | "resolution" | "host_selection" | "host_active_layer" | "host_current_frame" | "host_work_area";
export type PortableToolField = { id: string; label?: string; description?: string; type: PortableToolValueType; required?: boolean; default?: unknown; min?: number; max?: number; step?: number; options?: Array<{ value: string | number | boolean; label?: string }>; multiple?: boolean; minItems?: number; maxItems?: number; acceptedMimes?: string[]; source?: PortableToolSource; hostSources?: Partial<Record<"boojumroute" | "after_effects" | "photoshop", PortableToolSource>> };
export type PortableToolSchema = { schemaVersion: string; id: string; title: string; description?: string; version: string; action: { kind: "node" | "endpoint"; value: string }; inputs: PortableToolField[]; outputs: Array<PortableToolField & { placement: string; hostPlacements?: Record<string, string>; allowSelection?: boolean }>; params?: PortableToolField[]; hosts: Array<{ host: string; sources: PortableToolSource[]; placements: string[]; capabilities?: string[] }>; job: { states: string[]; cancellable: boolean; retryable: boolean; selectableResults: boolean }; pricing?: { currency?: string; unit?: string; estimateEndpoint?: string; configuredRate?: number } };
export type PublishedTool = { tool: PortableToolSchema; source: "explicit" | "legacy" };
export type PortableToolJob = { id: string; status: "queued" | "starting_provider" | "loading_model" | "generating" | "generating_768p" | "regenerating_2k" | "downloading" | "completed" | "failed" | "cancelled"; progress: number; createdAt: string; updatedAt: string; error?: string; selectedResultId?: string; results?: Array<{ id: string; outputId: string; type: "image" | "video" | "audio" | "text"; label: string; text?: string; url?: string; filename?: string }> };
export type H3RegenerationQuote = { durationSeconds: number; rateUsdPerSecond: number; providerUsd: number; baseCredits: number; markupCredits: number; finalCredits: number; currency: "USD"; source: string; effectiveDate: string };
export type H3RegenerationJob = { id: string; sourceToolJobId: string; sourceResultId: string; status: "queued" | "regenerating_2k" | "downloading" | "completed" | "failed" | "cancelled"; progress: number; quote: H3RegenerationQuote; costs?: H3RegenerationQuote; result?: { type: "video"; filename: string; url: string }; error?: string };

const supportedSources = new Set<PortableToolSource>(["manual", "upload", "host_selection", "host_active_layer", "host_current_frame", "host_first_frame", "host_last_frame"]);

export function sourceForAfterEffects(field: PortableToolField): PortableToolSource { return field.hostSources?.after_effects ?? field.source ?? "manual"; }
export function mediaKindForToolField(field: PortableToolField): "image" | "video" | "audio" | "text" { if (["image", "images", "mask", "host_selection", "host_active_layer", "host_current_frame"].includes(field.type)) return "image"; if (["video", "videos", "host_work_area"].includes(field.type)) return "video"; return field.type === "audio" ? "audio" : "text"; }
export function isMediaToolField(field: PortableToolField) { return mediaKindForToolField(field) !== "text"; }
export function defaultToolValues(tool: PortableToolSchema): Record<string, unknown> { return Object.fromEntries([...(tool.params ?? []), ...tool.inputs.filter((field) => !isMediaToolField(field) && sourceForAfterEffects(field) === "manual")].map((field) => [field.id, field.default ?? (field.type === "boolean" ? false : "")])); }
export function afterEffectsToolSupport(tool: PortableToolSchema): { supported: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!tool.hosts.some((contract) => contract.host === "after_effects")) reasons.push("Tool does not declare After Effects support.");
  for (const field of tool.inputs) {
    const source = sourceForAfterEffects(field);
    if (!supportedSources.has(source)) reasons.push(`${field.label ?? field.id}: source ${source} is unavailable in this panel build.`);
    if (field.multiple || field.type === "images" || field.type === "videos") reasons.push(`${field.label ?? field.id}: multiple host captures are not implemented yet.`);
    if (source === "host_active_layer" && mediaKindForToolField(field) !== "image") reasons.push(`${field.label ?? field.id}: selected-layer ${mediaKindForToolField(field)} export is not implemented yet.`);
  }
  return { supported: reasons.length === 0, reasons };
}
export function normalizeToolValues(tool: PortableToolSchema, values: Record<string, unknown>) {
  return Object.fromEntries((tool.params ?? []).map((field) => [field.id, coerce(field, values[field.id] ?? field.default)]).filter(([, value]) => value !== undefined));
}
export function validateToolValues(tool: PortableToolSchema, values: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of [...(tool.params ?? []), ...tool.inputs.filter((item) => !isMediaToolField(item) && sourceForAfterEffects(item) === "manual")]) {
    const value = coerce(field, values[field.id] ?? field.default);
    if (field.required && (value === undefined || value === "")) errors.push(`${field.label ?? field.id} is required.`);
    if (typeof value === "number" && field.min !== undefined && value < field.min) errors.push(`${field.label ?? field.id} must be at least ${field.min}.`);
    if (typeof value === "number" && field.max !== undefined && value > field.max) errors.push(`${field.label ?? field.id} must be at most ${field.max}.`);
    if (field.type === "select" && value !== undefined && !field.options?.some((option) => Object.is(option.value, value))) errors.push(`${field.label ?? field.id} must use an available option.`);
  }
  return errors;
}
export function manualToolInputs(tool: PortableToolSchema, values: Record<string, unknown>) { return Object.fromEntries(tool.inputs.filter((field) => !isMediaToolField(field) && sourceForAfterEffects(field) === "manual").map((field) => [field.id, { type: "text" as const, text: String(values[field.id] ?? field.default ?? "") }])); }

function coerce(field: PortableToolField, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return field.required ? value : undefined;
  if (["number", "integer", "seed", "duration"].includes(field.type)) { const number = Number(value); return Number.isFinite(number) ? (field.type === "integer" || field.type === "seed" ? Math.trunc(number) : number) : value; }
  if (field.type === "boolean") return value === true || value === "true";
  if (field.type === "select") return field.options?.find((option) => String(option.value) === String(value))?.value ?? value;
  return value;
}
