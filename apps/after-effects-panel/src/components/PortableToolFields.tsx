import type { PortableToolField } from "../tools/schema";

export function PortableToolFields({ fields, values, onChange }: { fields: PortableToolField[]; values: Record<string, unknown>; onChange(id: string, value: unknown): void }) {
  return <>{fields.map((field) => <label className="field" key={field.id}><span>{field.label ?? field.id}{field.required ? " *" : ""}</span>{control(field, values[field.id] ?? field.default ?? "", onChange)}{field.description && <small>{field.description}</small>}</label>)}</>;
}
function control(field: PortableToolField, value: unknown, onChange: (id: string, value: unknown) => void) {
  if (field.type === "boolean") return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(field.id, event.target.checked)} />;
  if (field.type === "select") return <select value={String(value)} onChange={(event) => onChange(field.id, event.target.value)}>{field.options?.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label ?? String(option.value)}</option>)}</select>;
  if (["number", "integer", "seed", "duration"].includes(field.type)) return <input type="number" value={String(value)} min={field.min} max={field.max} step={field.step ?? (field.type === "integer" || field.type === "seed" ? 1 : undefined)} onChange={(event) => onChange(field.id, event.target.value)} />;
  if (field.type === "multiline_text") return <textarea rows={3} value={String(value)} onChange={(event) => onChange(field.id, event.target.value)} />;
  return <input type="text" value={String(value)} onChange={(event) => onChange(field.id, event.target.value)} />;
}
