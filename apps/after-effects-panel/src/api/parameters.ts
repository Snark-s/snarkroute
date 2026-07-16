import type { ParameterDefinition } from "../types";

export function gatewayParameters(schema: ParameterDefinition[], values: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Map(schema.map((field) => [field.id, field]));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = allowed.get(key);
    if (!field || value === "" || value === undefined || value === null) continue;
    if (field.type === "boolean" && typeof value !== "boolean") continue;
    if (field.type === "number") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      result[key] = numeric;
      continue;
    }
    if (field.type === "select" && field.options?.length && !field.options.some((option) => option.value === String(value))) continue;
    result[key] = value;
  }
  return result;
}
