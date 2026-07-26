import type { ParameterDefinition } from "../types";

export function ParameterFields({ fields, values, onChange, advanced = false }: { fields: ParameterDefinition[]; values: Record<string, unknown>; onChange(id: string, value: unknown): void; advanced?: boolean }) {
  return <>{fields.filter((field) => Boolean(field.advanced) === advanced).map((field) => <label key={field.id} className="field"><span>{field.label ?? field.id}</span>{control(field, values[field.id] ?? field.default ?? "", onChange)}</label>)}</>;
}

function control(field: ParameterDefinition, value: unknown, onChange: (id: string, value: unknown) => void) {
  if (field.type === "boolean") return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(field.id, event.target.checked)} />;
  if (field.type === "select") return <select value={String(value)} onChange={(event) => onChange(field.id, event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label ?? option.value}</option>)}</select>;
  if (field.type === "number") return <input type="number" value={String(value)} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(field.id, event.target.value)} />;
  if (field.type === "multiline") return <textarea rows={3} value={String(value)} onChange={(event) => onChange(field.id, event.target.value)} />;
  if (field.type === "slider") return <input type="range" value={String(value)} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(field.id, Number(event.target.value))} />;
  return <input type="text" value={String(value)} onChange={(event) => onChange(field.id, event.target.value)} />;
}
