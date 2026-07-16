import type { ModelIOContract, ModelIOItem, ModelMediaKind } from "@snarkroute/protocol";

type ModelInputContractSource = {
  ioContract?: ModelIOContract;
  inputTypes?: string[];
  outputTypes?: string[];
  metadata?: Record<string, unknown>;
};

export type SuppliedModelInputsV1 = Partial<Record<ModelMediaKind, number>>;

export type ModelImageInputContractV1 = {
  requiredImageInputs: number;
  maximumImageInputs: number;
  optionalImageInputs: number;
  inputRoles: string[];
};

export function modelIOContractV1(model: ModelInputContractSource): ModelIOContract | undefined {
  if (model.ioContract) return model.ioContract;
  const inputs = (model.inputTypes ?? []).flatMap((kind) => mediaItem(kind, 0, legacyMaximum(model, kind)));
  const outputs = (model.outputTypes ?? []).flatMap((kind) => mediaItem(kind, 1, 1));
  return inputs.length || outputs.length ? { inputs, outputs } : undefined;
}

export function providerParameterIOContractV1(
  parameters: Record<string, unknown> | undefined,
  inputTypes: string[] = [],
  outputTypes: string[] = []
): ModelIOContract | undefined {
  const inputs: ModelIOItem[] = [];
  for (const kind of ["image", "video", "audio", "file"] as const) {
    const matching = Object.entries(parameters ?? {}).filter(([key]) => parameterKind(key) === kind);
    if (matching.length) {
      const items = matching.map(([key, value]) => parameterItem(kind, key, value));
      inputs.push({
        kind,
        minItems: items.reduce((sum, item) => sum + (item.minItems ?? 0), 0),
        maxItems: items.reduce((sum, item) => sum + (item.maxItems ?? 1), 0),
        required: items.some((item) => item.required),
        roles: unique(items.flatMap((item) => inputRoles(item)))
      });
    } else if (inputTypes.includes(kind)) {
      inputs.push({ kind, minItems: 0, maxItems: 1 });
    }
  }
  if (inputTypes.includes("text")) inputs.unshift({ kind: "text", minItems: 0, maxItems: 1 });
  const outputs = outputTypes.flatMap((kind) => mediaItem(kind, 1, 1));
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
    inputRoles: inputRoles(image)
  };
}

export function modelRunnableWithSuppliedInputsV1(model: ModelInputContractSource, supplied: SuppliedModelInputsV1): boolean {
  return modelInputCompatibilityReasonsV1(model, supplied).length === 0;
}

export function modelInputCompatibilityReasonsV1(model: ModelInputContractSource, supplied: SuppliedModelInputsV1): string[] {
  const inputs = modelIOContractV1(model)?.inputs ?? [];
  const reasons: string[] = [];
  for (const kind of Object.keys(supplied) as ModelMediaKind[]) {
    const count = nonnegativeInteger(supplied[kind]) ?? 0;
    const item = inputs.find((candidate) => candidate.kind === kind);
    if (!item) {
      if (count > 0) reasons.push(`unsupported ${kind} input`);
      continue;
    }
    const minimum = item.minItems ?? (item.required ? 1 : 0);
    const maximum = item.maxItems;
    if (count < minimum) reasons.push(`requires ${minimum} ${kind} input${minimum === 1 ? "" : "s"}`);
    if (maximum !== undefined && count > maximum) reasons.push(`accepts at most ${maximum} ${kind} input${maximum === 1 ? "" : "s"}`);
  }
  return reasons;
}

function parameterItem(kind: ModelMediaKind, key: string, value: unknown): ModelIOItem {
  const record = objectValue(value);
  const minimum = nonnegativeInteger(record.min) ?? (record.required === true ? 1 : 0);
  const maximum = nonnegativeInteger(record.max) ?? 1;
  return {
    kind,
    minItems: minimum,
    maxItems: maximum,
    required: minimum > 0,
    roles: inferRoles(kind, key, typeof record.description === "string" ? record.description : "")
  };
}

function parameterKind(key: string): ModelMediaKind | undefined {
  const normalized = key.toLowerCase();
  if (/^(images?|image_url|tail_image_url|first_frame(?:_image|_url)?|last_frame(?:_image|_url)?|start_image|end_image|reference_images?)$/.test(normalized)) return "image";
  if (/^(videos?|video_url|reference_videos?)$/.test(normalized)) return "video";
  if (/^(audios?|audio_url|reference_audios?)$/.test(normalized)) return "audio";
  if (/^(files?|file_url)$/.test(normalized)) return "file";
  return undefined;
}

function inferRoles(kind: ModelMediaKind, key: string, description: string): string[] {
  const text = `${key} ${description}`.toLowerCase();
  const roles: string[] = [];
  if (/first|start|начал|перв/.test(text)) roles.push("first_frame");
  if (/last|tail|end|конц|послед/.test(text)) roles.push("last_frame");
  if (/reference|ref_|референс|опор/.test(text)) roles.push("reference");
  return roles.length ? unique(roles) : [kind];
}

function inputRoles(item: ModelIOItem | undefined): string[] {
  const roles = item && "roles" in item && Array.isArray(item.roles) ? item.roles.map(String) : [];
  return unique(roles);
}

function mediaItem(kind: string, minItems: number, maxItems: number): ModelIOItem[] {
  return isMediaKind(kind) ? [{ kind, minItems, maxItems }] : [];
}

function isMediaKind(value: string): value is ModelMediaKind {
  return ["text", "image", "video", "audio", "file", "json"].includes(value);
}

function legacyMaximum(model: ModelInputContractSource, kind: string): number {
  if (kind !== "image") return 1;
  return positiveInteger(model.metadata?.maxImageInputs) ?? positiveInteger(model.metadata?.maxImages) ?? 1;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
