export type Bounds = { left: number; top: number; right: number; bottom: number };
export type SelectionMode = "replace_selection" | "selection_input";
export type SelectionPlan = { mode: SelectionMode; originalBounds: Bounds; selectionBounds: Bounds; contextBounds: Bounds; resultOrigin: { left: number; top: number }; clipToSelection: boolean; contextPadding: number; width: number; height: number };

export function createSelectionPlan(selection: Bounds, document: { width: number; height: number }, contextPadding = 0.2, mode: SelectionMode = "replace_selection"): SelectionPlan {
  if (!Number.isFinite(document.width) || !Number.isFinite(document.height) || document.width <= 0 || document.height <= 0) throw new Error("Document dimensions are invalid.");
  if (!validBounds(selection)) throw new Error("Photoshop has no usable pixel selection.");
  const padding = Math.max(0, Math.min(1, Number.isFinite(contextPadding) ? contextPadding : 0.2));
  const selectionBounds = clampBounds(selection, document);
  if (!validBounds(selectionBounds)) throw new Error("The selection is outside the document canvas.");
  const width = selectionBounds.right - selectionBounds.left, height = selectionBounds.bottom - selectionBounds.top;
  const contextBounds = clampBounds({ left: selectionBounds.left - width * padding, top: selectionBounds.top - height * padding, right: selectionBounds.right + width * padding, bottom: selectionBounds.bottom + height * padding }, document, true);
  return { mode, originalBounds: selection, selectionBounds, contextBounds, resultOrigin: { left: contextBounds.left, top: contextBounds.top }, clipToSelection: mode === "replace_selection", contextPadding: padding, width: contextBounds.right - contextBounds.left, height: contextBounds.bottom - contextBounds.top };
}

export function resultMaskPlan(plan: SelectionPlan) { return { targetBounds: { left: plan.selectionBounds.left, top: plan.selectionBounds.top }, sourceBounds: plan.selectionBounds, clipToSelection: plan.clipToSelection }; }

function clampBounds(bounds: Bounds, document: { width: number; height: number }, round = false): Bounds { const value = { left: Math.max(0, Math.min(document.width, bounds.left)), top: Math.max(0, Math.min(document.height, bounds.top)), right: Math.max(0, Math.min(document.width, bounds.right)), bottom: Math.max(0, Math.min(document.height, bounds.bottom)) }; return round ? { left: Math.floor(value.left), top: Math.floor(value.top), right: Math.ceil(value.right), bottom: Math.ceil(value.bottom) } : value; }
function validBounds(bounds: Bounds) { return [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) && bounds.right > bounds.left && bounds.bottom > bounds.top; }
