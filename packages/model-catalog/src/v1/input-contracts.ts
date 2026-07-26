import type { ModelIOContract, ModelIOInputSlot, ModelIOItem, ModelMediaKind } from "@snarkroute/protocol";

export type SuppliedModelInputsV1 = Partial<Record<"image" | "video" | "audio", number>>;
export type ModelInputSlotV1 = ModelIOInputSlot & { kind: ModelMediaKind };
type ModelInputContractSource = {
  ioContract?: ModelIOContract;
  inputContract?: ModelIOContract;
  inputTypes?: string[];
  outputTypes?: string[];
  metadata?: Record<string, unknown>;
};
export type ModelImageInputContractV1 = {
  requiredImageInputs: number;
  maximumImageInputs: number;
  optionalImageInputs: number;
  inputRoles: string[];
};

export function modelIOContractV1(model: ModelInputContractSource): ModelIOContract | undefined {
  const explicitContract = model.inputContract ?? model.ioContract;
  if (explicitContract) return explicitContract;
  const inputs = (model.inputTypes ?? []).filter(isMediaKind).map((kind): ModelIOItem => ({
    kind,
    minItems: 0,
    maxItems: legacyMaximum(model, kind)
  }));
  const outputs = (model.outputTypes ?? []).filter(isMediaKind).map((kind): ModelIOItem => ({
    kind,
    minItems: 1,
    maxItems: 1,
    required: true
  }));
  return inputs.length || outputs.length ? { inputs, outputs } : undefined;
}

export function modelImageInputContractV1(model: ModelInputContractSource): ModelImageInputContractV1 {
  const image = modelIOContractV1(model)?.inputs?.find((item) => item.kind === "image");
  const requiredImageInputs = image?.minItems ?? (image?.required ? 1 : 0);
  const maximumImageInputs = image?.maxItems ?? (image ? Number.MAX_SAFE_INTEGER : 0);
  return {
    requiredImageInputs,
    maximumImageInputs,
    optionalImageInputs: Math.max(0, maximumImageInputs - requiredImageInputs),
    inputRoles: unique([
      ...(image?.roles ?? []).map(String),
      ...(image?.slots ?? []).map((slot) => String(slot.role))
    ])
  };
}

export function providerParameterIOContractV1(parameters: Record<string, unknown> | undefined, inputTypes: string[] = [], outputTypes: string[] = []): ModelIOContract {
  const fields = Object.entries(parameters ?? {}).flatMap(([id, value]) => {
    const kind = parameterMediaKind(id);
    if (!kind || !value || typeof value !== "object" || Array.isArray(value)) return [];
    const schema = value as Record<string, unknown>;
    const minItems = nonnegativeInteger(schema.min) ?? (schema.required === true ? 1 : 0);
    const maxItems = nonnegativeInteger(schema.max) ?? 1;
    return [{ id, kind, schema, minItems, maxItems }];
  });
  const mediaInputs = (["image", "video", "audio"] as const).flatMap((kind): ModelIOItem[] => {
    const matching = fields.filter((field) => field.kind === kind);
    if (!matching.length) return inputTypes.includes(kind) ? [{ kind, minItems: 0, maxItems: 1, required: false, roles: [defaultRole(kind)], slots: [{ id: kind, role: defaultRole(kind), label: defaultLabel(kind), minItems: 0, maxItems: 1, required: false, ordered: true }] }] : [];
    const hasLastFrame = matching.some((field) => field.id.toLowerCase().includes("tail") || field.id.toLowerCase().includes("last"));
    const slots = matching.flatMap((field) => parameterSlots(field, outputTypes, hasLastFrame));
    const minItems = matching.reduce((sum, field) => sum + field.minItems, 0);
    const maxItems = matching.reduce((sum, field) => sum + field.maxItems, 0);
    return [{ kind, minItems, maxItems, required: minItems > 0, roles: unique(slots.map((slot) => slot.role)), slots, ordered: true }];
  });
  const inputs: ModelIOItem[] = inputTypes.includes("text")
    ? [{ kind: "text", minItems: 0, maxItems: 1 }, ...mediaInputs]
    : mediaInputs;
  const outputs = outputTypes.filter(isMediaKind).map((kind): ModelIOItem => ({ kind, minItems: 1, maxItems: 1, required: true }));
  return { inputs, outputs };
}

export function modelInputSlotsV1(model: ModelInputContractSource): ModelInputSlotV1[] {
  const contract = modelIOContractV1(model);
  return (contract?.inputs ?? []).flatMap((item) => item.slots?.length
    ? item.slots.map((slot) => ({ ...slot, kind: item.kind }))
    : [{ kind: item.kind, id: item.kind, role: item.roles?.[0] ?? defaultRole(item.kind), label: defaultLabel(item.kind), minItems: item.minItems ?? (item.required ? 1 : 0), maxItems: item.maxItems ?? 1, required: item.required ?? (item.minItems ?? 0) > 0, ordered: item.ordered ?? true }]);
}

export function panelCanRepresentContractV1(model: ModelInputContractSource, supportedKinds: string[]): boolean {
  const supported = new Set(supportedKinds);
  return (modelIOContractV1(model)?.inputs ?? []).every((item) => (item.minItems ?? (item.required ? 1 : 0)) === 0 || supported.has(item.kind));
}

export function modelInputCompatibilityReasonsV1(model: ModelInputContractSource, supplied: SuppliedModelInputsV1): string[] {
  const inputs = modelIOContractV1(model)?.inputs ?? [];
  const unsupported = (Object.entries(supplied) as Array<[keyof SuppliedModelInputsV1, number | undefined]>).flatMap(([kind, count]) =>
    (count ?? 0) > 0 && !inputs.some((item) => item.kind === kind) ? [`unsupported ${kind} input`] : []
  );
  return [...unsupported, ...inputs.flatMap((item) => {
    if (!(item.kind === "image" || item.kind === "video" || item.kind === "audio")) return [];
    const count = supplied[item.kind] ?? 0;
    const min = item.minItems ?? (item.required ? 1 : 0);
    const max = item.maxItems ?? Number.POSITIVE_INFINITY;
    return count < min ? [`${item.kind} requires at least ${min}, got ${count}`] : count > max ? [`${item.kind} accepts at most ${max}, got ${count}`] : [];
  })];
}

export function modelRunnableWithSuppliedInputsV1(model: ModelInputContractSource, supplied: SuppliedModelInputsV1): boolean {
  return modelInputCompatibilityReasonsV1(model, supplied).length === 0;
}

function parameterSlots(field: { id: string; kind: "image" | "video" | "audio"; schema: Record<string, unknown>; minItems: number; maxItems: number }, outputTypes: string[], hasLastFrame: boolean): ModelIOInputSlot[] {
  const id = field.id.toLowerCase();
  const description = typeof field.schema.description === "string" ? field.schema.description.toLowerCase() : "";
  if (field.kind === "image" && (id.includes("tail") || id.includes("last"))) return [slot(field, "lastFrame", "Last frame")];
  const firstLast = field.kind === "image" && field.maxItems >= 2 && /(first.*last|start.*end|начал.*кон|перв.*послед)/i.test(description);
  if (firstLast) return [
    { id: `${field.id}.first`, role: "firstFrame", label: "First frame", minItems: field.minItems > 0 ? 1 : 0, maxItems: 1, required: field.minItems > 0, ordered: true },
    { id: `${field.id}.last`, role: "lastFrame", label: "Last frame", minItems: Math.max(0, field.minItems - 1), maxItems: 1, required: field.minItems > 1, ordered: true }
  ];
  if (field.kind === "image") {
    const role = hasLastFrame ? "firstFrame" : field.maxItems > 1 || /reference|референс|опорн/i.test(description) ? "reference" : outputTypes.includes("video") ? "firstFrame" : "sourceImage";
    return [slot(field, role, role === "firstFrame" ? "First frame" : role === "reference" ? "Reference images" : "Source image")];
  }
  if (field.kind === "video") return [slot(field, "sourceVideo", field.maxItems > 1 ? "Reference videos" : "Source video")];
  return [slot(field, "audio", "Audio")];
}

function slot(field: { id: string; minItems: number; maxItems: number }, role: string, label: string): ModelIOInputSlot {
  return { id: field.id, role, label, minItems: field.minItems, maxItems: field.maxItems, required: field.minItems > 0, ordered: true };
}
function parameterMediaKind(id: string): "image" | "video" | "audio" | undefined {
  const key = id.toLowerCase();
  if (/audio_ids?|character_ids?|generate_audio|sound/.test(key)) return undefined;
  if (/image|images/.test(key)) return "image";
  if (/video|videos/.test(key)) return "video";
  if (/audio|audios/.test(key)) return "audio";
  return undefined;
}
function defaultRole(kind: string) { return kind === "image" ? "sourceImage" : kind === "video" ? "sourceVideo" : kind; }
function defaultLabel(kind: string) { return kind === "image" ? "Source image" : kind === "video" ? "Source video" : kind === "audio" ? "Audio" : kind; }
function nonnegativeInteger(value: unknown) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined; }
function isMediaKind(value: string): value is ModelMediaKind { return ["text", "image", "video", "audio", "file", "json"].includes(value); }
function legacyMaximum(model: ModelInputContractSource, kind: string) {
  if (kind !== "image") return 1;
  return positiveInteger(model.metadata?.maxImageInputs) ?? positiveInteger(model.metadata?.maxImages) ?? 1;
}
function positiveInteger(value: unknown) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
