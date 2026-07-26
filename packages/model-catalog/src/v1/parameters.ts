import type { ModelParameterDefinitionV1, ModelParameterValueV1 } from "./types.js";

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
