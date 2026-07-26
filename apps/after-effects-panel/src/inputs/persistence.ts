import type { GenerationOperation, InputSlotState } from "../types";

const key = "snarkroute.after-effects.generation-form.v2";
export type PersistedGenerationForm = { operation: GenerationOperation; modelId: string; inputs: InputSlotState[]; parameters: Record<string, unknown> };

export function restoreGenerationForm(): PersistedGenerationForm | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PersistedGenerationForm | null;
    return value && typeof value === "object" && Array.isArray(value.inputs) ? value : null;
  } catch { return null; }
}

export function saveGenerationForm(value: PersistedGenerationForm): void {
  localStorage.setItem(key, JSON.stringify(value));
}
