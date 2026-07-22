import { describe, expect, it } from "vitest";
import { addSlotItem, inputSlotsForModel, inputValidationErrors, moveSlotItem, panelCanRepresentModel, reconcileInputSlots, removeSlotItem } from "./contracts";
import type { GenerationModel } from "../types";

const model = (inputs: NonNullable<GenerationModel["inputContract"]>["inputs"]): GenerationModel => ({ id: "m", storedModelId: "m", providerModelId: "m", provider: "polza", displayName: "M", inputTypes: [], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"], availability: { status: "available" }, parameters: [], nodeType: "polza.video.generate", inputContract: { inputs, outputs: [{ kind: "video", minItems: 1, maxItems: 1 }] } });

describe("CEP input contracts", () => {
  it("renders separate first and optional last frame slots", () => {
    const slots = inputSlotsForModel(model([{ kind: "image", minItems: 0, maxItems: 2, slots: [{ id: "first", role: "firstFrame", minItems: 0, maxItems: 1 }, { id: "last", role: "lastFrame", minItems: 0, maxItems: 1 }] }]), "image-to-video");
    expect(slots.map((slot) => [slot.role, slot.required])).toEqual([["firstFrame", true], ["lastFrame", false]]);
  });
  it("enforces collection min/max and keeps ordered items", () => {
    const [slot] = inputSlotsForModel(model([{ kind: "image", minItems: 1, maxItems: 4, slots: [{ id: "refs", role: "reference", minItems: 1, maxItems: 4, ordered: true }] }]), "image-to-video");
    const four = addSlotItem(addSlotItem(addSlotItem(slot)));
    expect(addSlotItem(four).items).toHaveLength(4);
    expect(removeSlotItem(slot, 0).items).toHaveLength(1);
    const filled = { ...four, items: four.items.map((_, index) => ({ sourceType: "external-file" as const, kind: "image" as const, path: `${index}.png`, validationState: "ready" as const })) };
    expect(moveSlotItem(filled, 0, 1).items.map((item) => item?.path)).toEqual(["1.png", "0.png", "2.png", "3.png"]);
  });
  it("supports optional audio and required external video contracts", () => {
    const optionalAudio = model([{ kind: "image", minItems: 1, maxItems: 1 }, { kind: "audio", minItems: 0, maxItems: 1 }]);
    expect(panelCanRepresentModel(optionalAudio)).toBe(true);
    const requiredVideo = model([{ kind: "image", minItems: 1, maxItems: 1 }, { kind: "video", minItems: 1, maxItems: 1 }]);
    expect(panelCanRepresentModel(requiredVideo)).toBe(true);
    expect(inputSlotsForModel(requiredVideo, "image-to-video").map((slot) => slot.kind)).toEqual(["image", "video"]);
  });
  it("preserves only exact kind/role matches during model changes", () => {
    const previous = inputSlotsForModel(model([{ kind: "image", minItems: 0, maxItems: 2, slots: [{ id: "first", role: "firstFrame", maxItems: 1 }, { id: "last", role: "lastFrame", maxItems: 1 }] }]), "image-to-video");
    previous[1].items[0] = { sourceType: "external-file", kind: "image", path: "last.png", validationState: "ready" };
    const next = inputSlotsForModel(model([{ kind: "image", minItems: 0, maxItems: 1, slots: [{ id: "ref", role: "reference", maxItems: 1 }] }]), "image-to-video");
    expect(reconcileInputSlots(next, previous)).toMatchObject({ removedFilled: 1 });
    expect(inputValidationErrors(model([{ kind: "image", minItems: 1, maxItems: 1 }]), next)).not.toHaveLength(0);
  });
});
