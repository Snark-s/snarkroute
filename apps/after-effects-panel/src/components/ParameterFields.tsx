import type { ParameterDefinition } from "../types";

export function ParameterFields({ fields, values, onChange, advanced = false }: { fields: ParameterDefinition[]; values: Record<string, unknown>; onChange(id: string, value: unknown): void; advanced?: boolean }) {
  return <>{fields.filter((field) => Boolean(field.advanced) === advanced).map((field) => <label key={field.id} className="field"><span>{field.label ?? field.id}{field.required ? " · required" : ""}</span>{control(field, values[field.id] ?? field.default ?? "", onChange)}</label>)}</>;
}

function control(field: ParameterDefinition, value: unknown, onChange: (id: string, value: unknown) => void) {
  if (field.type === "boolean") return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(field.id, event.target.checked)} />;
  if (field.type === "select") return <select aria-label={field.label ?? field.id} required={field.required} value={String(value)} onChange={(event) => onChange(field.id, event.target.value)}>{value === "" && <option value="">Select…</option>}{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label ?? option.value}</option>)}</select>;
  if (field.type === "number") return <input type="number" value={String(value)} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(field.id, event.target.value)} />;
  return <input type="text" value={String(value)} onChange={(event) => onChange(field.id, event.target.value)} />;
}
