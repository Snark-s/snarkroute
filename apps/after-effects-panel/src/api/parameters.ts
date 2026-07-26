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

export function parameterValidationErrors(schema: ParameterDefinition[], values: Record<string, unknown>): string[] {
  const normalized = gatewayParameters(schema, values);
  return schema.flatMap((field) => {
    if (!field.required) return [];
    const value = normalized[field.id];
    return value === undefined || value === "" ? [`${field.label ?? field.id} is required.`] : [];
  });
}

export function parametersFromComposition(schema: ParameterDefinition[], values: Record<string, unknown>, width: number, height: number): { values: Record<string, unknown>; warning?: string } {
  const next = { ...values };
  const widthField = schema.find((field) => field.id.toLowerCase() === "width");
  const heightField = schema.find((field) => field.id.toLowerCase() === "height");
  const ratioField = schema.find((field) => ["aspectratio", "aspect_ratio"].includes(field.id.toLowerCase()));
  const warnings: string[] = [];
  if (widthField && heightField) {
    const fittedWidth = fitDimension(width, widthField);
    const fittedHeight = fitDimension(height, heightField);
    next[widthField.id] = fittedWidth;
    next[heightField.id] = fittedHeight;
    if (fittedWidth !== width || fittedHeight !== height) warnings.push(`Composition ${width} × ${height} was adjusted to ${fittedWidth} × ${fittedHeight} for this model.`);
  } else if (ratioField?.options?.length) {
    const ratio = nearestAspectRatio(width / height, ratioField.options.map((option) => option.value));
    next[ratioField.id] = ratio;
    warnings.push(`Composition aspect ratio maps to ${ratio}; the model does not accept exact width and height.`);
  } else if (widthField || heightField || ratioField) {
    warnings.push("This model does not expose a complete composition-size contract; choose a supported model preset or custom value.");
  }
  return { values: next, warning: warnings.join(" ") || undefined };
}

export function nearestAspectRatio(target: number, options: string[]): string {
  return [...options].sort((left, right) => Math.abs(parseRatio(left) - target) - Math.abs(parseRatio(right) - target))[0] ?? "";
}

function fitDimension(value: number, field: ParameterDefinition): number {
  const min = field.min ?? 1;
  const max = field.max ?? Number.MAX_SAFE_INTEGER;
  const multiple = field.multipleOf ?? field.step ?? 1;
  const clamped = Math.max(min, Math.min(max, value));
  return Math.max(min, Math.min(max, Math.round(clamped / multiple) * multiple));
}
function parseRatio(value: string): number { const [width, height] = value.split(/[:x]/i).map(Number); return width > 0 && height > 0 ? width / height : Number.POSITIVE_INFINITY; }
