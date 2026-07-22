import { modelInputCompatibilityReasonsV1, modelInputSlotsV1, panelCanRepresentContractV1 } from "@snarkroute/model-catalog";
import type { GenerationModel, GenerationOperation, InputSlotState, MediaKind } from "../types";

export const panelMaterializedKinds: MediaKind[] = ["image", "audio", "video"];

export function panelCanRepresentModel(model: GenerationModel): boolean {
  return panelCanRepresentContractV1(model, panelMaterializedKinds);
}

export function inputSlotsForModel(model: GenerationModel, operation: GenerationOperation): InputSlotState[] {
  const slots = modelInputSlotsV1(model).filter((slot): slot is typeof slot & { kind: MediaKind } => panelMaterializedKinds.includes(slot.kind as MediaKind));
  let forcedImage = false, forcedVideo = false, forcedAudio = false;
  return slots.map((slot) => {
    let minItems = slot.minItems ?? (slot.required ? 1 : 0);
    if (operation === "image-to-video" && slot.kind === "image" && !forcedImage) { minItems = Math.max(1, minItems); forcedImage = true; }
    if (operation === "video-to-video" && slot.kind === "video" && !forcedVideo) { minItems = Math.max(1, minItems); forcedVideo = true; }
    if (operation === "audio-conditioned-video" && slot.kind === "audio" && !forcedAudio) { minItems = Math.max(1, minItems); forcedAudio = true; }
    const maxItems = Math.max(minItems, slot.maxItems ?? 1);
    return {
      slotId: slot.id,
      kind: slot.kind,
      role: slot.role,
      label: slot.label ?? labelForRole(slot.role, slot.kind),
      minItems,
      maxItems,
      required: minItems > 0,
      ordered: slot.ordered ?? true,
      items: Array.from({ length: Math.max(1, minItems) }, () => null)
    };
  });
}

export function reconcileInputSlots(next: InputSlotState[], previous: InputSlotState[]): { slots: InputSlotState[]; removedFilled: number } {
  let removedFilled = 0;
  const used = new Set<string>();
  const slots = next.map((slot) => {
    const match = previous.find((candidate) => candidate.kind === slot.kind && candidate.role === slot.role && !used.has(candidate.slotId));
    if (!match) return slot;
    used.add(match.slotId);
    const items = match.items.slice(0, slot.maxItems);
    while (items.length < Math.max(1, slot.minItems)) items.push(null);
    removedFilled += match.items.slice(slot.maxItems).filter(Boolean).length;
    return { ...slot, items };
  });
  removedFilled += previous.filter((slot) => !used.has(slot.slotId)).flatMap((slot) => slot.items).filter(Boolean).length;
  return { slots, removedFilled };
}

export function inputValidationErrors(model: GenerationModel, slots: InputSlotState[]): string[] {
  const errors = slots.flatMap((slot) => {
    const ready = slot.items.filter((item) => item?.validationState !== "invalid" && item !== null).length;
    const invalid = slot.items.filter((item) => item?.validationState === "invalid");
    return [
      ...(ready < slot.minItems ? [`${slot.label} requires ${slot.minItems} input(s); ${ready} selected.`] : []),
      ...(ready > slot.maxItems ? [`${slot.label} accepts at most ${slot.maxItems} input(s).`] : []),
      ...invalid.map((item) => `${slot.label}: ${item?.error ?? "invalid source"}`)
    ];
  });
  return [...errors, ...modelInputCompatibilityReasonsV1(model, inputCounts(slots))];
}

export function inputCounts(slots: InputSlotState[]): Partial<Record<MediaKind, number>> {
  const counts: Partial<Record<MediaKind, number>> = {};
  for (const slot of slots) counts[slot.kind] = (counts[slot.kind] ?? 0) + slot.items.filter(Boolean).length;
  return counts;
}

export function addSlotItem(slot: InputSlotState): InputSlotState { return slot.items.length >= slot.maxItems ? slot : { ...slot, items: [...slot.items, null] }; }
export function removeSlotItem(slot: InputSlotState, index: number): InputSlotState {
  if (slot.items.length <= Math.max(1, slot.minItems)) return slot;
  return { ...slot, items: slot.items.filter((_, itemIndex) => itemIndex !== index) };
}
export function moveSlotItem(slot: InputSlotState, index: number, direction: -1 | 1): InputSlotState {
  const target = index + direction;
  if (target < 0 || target >= slot.items.length) return slot;
  const items = [...slot.items]; [items[index], items[target]] = [items[target], items[index]];
  return { ...slot, items };
}

function labelForRole(role: string, kind: string) {
  const labels: Record<string, string> = { firstFrame: "First frame", lastFrame: "Last frame", reference: "Reference images", styleReference: "Style reference", sourceImage: "Source image", sourceVideo: "Source video", audio: "Audio", mask: "Mask" };
  return labels[role] ?? `${role || kind}`;
}
