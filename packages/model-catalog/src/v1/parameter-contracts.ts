import type { ModelParameterDefinitionV1, ModelParameterValueV1 } from "./types.js";

const mediaParameter = /(^|_)(image|images|video|videos|audio|audios|mask|file|files|url|urls|ids?)($|_)/i;

export function providerParameterDefinitionsV1(parameters: Record<string, unknown> | undefined): ModelParameterDefinitionV1[] {
  return Object.entries(parameters ?? {}).flatMap(([id, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || mediaParameter.test(id) && !/^(generate_audio|sound)$/i.test(id) || id === "prompt") return [];
    const schema = value as Record<string, unknown>;
    const options = optionValues(schema);
    const type = options.length ? "select" : booleanSchema(schema) ? "boolean" : numberSchema(schema) ? "number" : "text";
    const definition: ModelParameterDefinitionV1 = { id, label: label(schema, id), type, required: schema.required === true, advanced: schema.advanced === true };
    const defaultValue = primitive(schema.default);
    if (defaultValue !== undefined) definition.default = defaultValue;
    if (options.length) definition.options = options.map((item) => ({ value: String(item), label: String(item) }));
    if (typeof schema.min === "number") definition.min = schema.min;
    if (typeof schema.max === "number") definition.max = schema.max;
    if (typeof schema.step === "number") definition.step = schema.step;
    return [definition];
  });
}

function optionValues(schema: Record<string, unknown>): ModelParameterValueV1[] {
  const value = schema.enum ?? schema.options ?? schema.values ?? schema.allowed_values;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => { const candidate = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).value : item; const parsed = primitive(candidate); return parsed === undefined ? [] : [parsed]; });
}
function primitive(value: unknown): ModelParameterValueV1 | undefined { return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function booleanSchema(schema: Record<string, unknown>) { return schema.type === "boolean" || typeof schema.default === "boolean"; }
function numberSchema(schema: Record<string, unknown>) { return schema.type === "number" || schema.type === "integer" || typeof schema.default === "number" || typeof schema.min === "number" || typeof schema.max === "number"; }
function label(schema: Record<string, unknown>, id: string) { return typeof schema.title === "string" && schema.title.trim() ? schema.title : id.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" "); }
