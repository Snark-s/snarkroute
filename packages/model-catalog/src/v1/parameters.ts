import type { ModelParameterDefinitionV1, ModelParameterValueV1 } from "./types.js";

const nonFormParameterIds = new Set([
  "prompt", "image", "images", "video", "videos", "audio", "audios", "file", "files"
]);

export function providerParameterDefinitionsV1(parameters: Record<string, unknown> | undefined): ModelParameterDefinitionV1[] {
  return Object.entries(parameters ?? {}).flatMap(([id, raw]) => {
    if (nonFormParameterIds.has(id.toLowerCase()) || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const schema = raw as Record<string, unknown>;
    const values = Array.isArray(schema.values) ? schema.values.filter(isParameterValue) : [];
    const defaultValue = isParameterValue(schema.default) ? schema.default : undefined;
    const type = parameterType(schema, values, defaultValue);
    const definition: ModelParameterDefinitionV1 = {
      id,
      label: parameterLabel(id),
      type,
      required: schema.required === true || undefined
    };
    if (defaultValue !== undefined) definition.default = defaultValue;
    if (values.length > 0) definition.options = values.map((value) => ({ value: String(value) }));
    if (typeof schema.min === "number") definition.min = schema.min;
    if (typeof schema.max === "number") definition.max = schema.max;
    if (typeof schema.step === "number") definition.step = schema.step;
    return [definition];
  });
}

export function mergeModelParameterDefinitionsV1(
  primary: ModelParameterDefinitionV1[],
  fallback: ModelParameterDefinitionV1[]
): ModelParameterDefinitionV1[] {
  const aliases = new Set(primary.map((field) => parameterSemanticIdV1(field.id)));
  return [...primary, ...fallback.filter((field) => !aliases.has(parameterSemanticIdV1(field.id)))];
}

export function normalizeModelParameterValuesV1(
  schema: ModelParameterDefinitionV1[],
  values: Record<string, unknown>
): Record<string, ModelParameterValueV1> {
  const result: Record<string, ModelParameterValueV1> = {};
  for (const field of schema) {
    const value = values[field.id];
    if (value === "" || value === undefined || value === null) continue;
    if (field.type === "boolean") {
      if (typeof value === "boolean") result[field.id] = value;
      continue;
    }
    if (field.type === "number") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) result[field.id] = numeric;
      continue;
    }
    const text = String(value);
    if (field.type === "select" && field.options?.length && !field.options.some((option) => option.value === text)) continue;
    result[field.id] = text;
  }
  return result;
}

export function modelParameterValidationReasonsV1(
  schema: ModelParameterDefinitionV1[],
  values: Record<string, unknown>
): string[] {
  const normalized = normalizeModelParameterValuesV1(schema, values);
  const reasons: string[] = [];
  for (const field of schema) {
    if (field.required && normalized[field.id] === undefined) reasons.push(`${field.label ?? field.id} is required`);
    const supplied = values[field.id];
    if (supplied !== undefined && supplied !== "" && normalized[field.id] === undefined) reasons.push(`${field.label ?? field.id} is invalid`);
  }
  return reasons;
}

export function parameterSemanticIdV1(id: string): string {
  return id.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parameterType(schema: Record<string, unknown>, values: ModelParameterValueV1[], defaultValue: ModelParameterValueV1 | undefined): ModelParameterDefinitionV1["type"] {
  if (values.length > 0) return "select";
  const declared = typeof schema.type === "string" ? schema.type.toLowerCase() : "";
  if (declared.includes("bool") || typeof defaultValue === "boolean") return "boolean";
  if (declared.includes("number") || declared.includes("integer") || typeof defaultValue === "number" || typeof schema.min === "number" || typeof schema.max === "number") return "number";
  return "text";
}

function parameterLabel(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : id;
}

function isParameterValue(value: unknown): value is ModelParameterValueV1 {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
