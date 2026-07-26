import type { AeInputSource, AeInputSourceType, InputSlotState } from "../types";

export function InputSlots({ slots, onSource, onAdd, onRemove, onMove, onReveal }: {
  slots: InputSlotState[];
  onSource(slotId: string, index: number, sourceType: AeInputSourceType | "none"): void;
  onAdd(slotId: string): void;
  onRemove(slotId: string, index: number): void;
  onMove(slotId: string, index: number, direction: -1 | 1): void;
  onReveal(path: string): void;
}) {
  if (!slots.length) return <small>No media inputs are required.</small>;
  return <div className="input-slots">{slots.map((slot) => <div className="input-slot" key={slot.slotId} data-kind={slot.kind} data-role={slot.role}>
    <div><strong>{slot.label}</strong> · {slot.kind} · {slot.required ? "required" : "optional"}</div>
    <small>Role: {slot.role} · {slot.minItems}–{slot.maxItems} · {slot.items.filter(Boolean).length}/{slot.maxItems}</small>
    {slot.items.map((item, index) => <div className="input-item" key={`${slot.slotId}:${index}`}>
      <label className="field"><span>{slot.maxItems > 1 ? `${index + 1}. Source` : "Source"}</span><select aria-label={`${slot.label} source ${index + 1}`} value={selectorValue(item)} onChange={(event) => onSource(slot.slotId, index, event.target.value as AeInputSourceType | "none")}>
        <option value="none">None</option>
        {slot.kind === "image" && <option value="current-composition-frame">Current composition frame</option>}
        {slot.kind === "image" && <option value="captured-composition-frame">Capture current frame…</option>}
        <option value="external-file">External {slot.kind} file…</option>
      </select></label>
      {item && <div className="diagnostics"><div>Status: {item.validationState ?? "ready"}</div><div>Source: {item.sourceType}</div>{item.compositionName && <div>{item.compositionName} · {formatTime(item.compositionTime)}</div>}{item.path && <div>Path: {item.path}</div>}{item.fileSize !== undefined && <div>Size: {item.fileSize} bytes</div>}{item.error && <div className="error-text">{item.error}</div>}</div>}
      <div className="input-actions">{item?.path && <button onClick={() => onReveal(item.path!)}>Reveal</button>}<button onClick={() => onSource(slot.slotId, index, "none")}>Clear</button>{slot.items.length > Math.max(1, slot.minItems) && <button onClick={() => onRemove(slot.slotId, index)}>Remove</button>}{slot.ordered && slot.items.length > 1 && <><button disabled={index === 0} onClick={() => onMove(slot.slotId, index, -1)}>Move up</button><button disabled={index === slot.items.length - 1} onClick={() => onMove(slot.slotId, index, 1)}>Move down</button></>}</div>
    </div>)}
    {slot.items.length < slot.maxItems && <button onClick={() => onAdd(slot.slotId)}>Add {slot.kind}</button>}
  </div>)}</div>;
}

function selectorValue(item: AeInputSource | null): AeInputSourceType | "none" { return item?.sourceType ?? "none"; }
function formatTime(value: number | undefined) { return value === undefined ? "" : `${value.toFixed(3)}s`; }
