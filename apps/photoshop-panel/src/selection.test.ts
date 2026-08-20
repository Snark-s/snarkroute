import { describe, expect, it } from "vitest";
import { createSelectionPlan, resultMaskPlan } from "./selection";

describe("Photoshop selection planning", () => {
  it("adds 20% context, clips it to the canvas, and retains exact selection placement", () => { const plan = createSelectionPlan({ left: 10, top: 20, right: 110, bottom: 70 }, { width: 120, height: 100 }); expect(plan).toMatchObject({ selectionBounds: { left: 10, top: 20, right: 110, bottom: 70 }, contextBounds: { left: 0, top: 10, right: 120, bottom: 80 }, resultOrigin: { left: 0, top: 10 }, clipToSelection: true }); expect(resultMaskPlan(plan).targetBounds).toEqual({ left: 10, top: 20 }); });
  it("handles selections extending beyond the document", () => { expect(createSelectionPlan({ left: -10, top: -5, right: 5, bottom: 4 }, { width: 100, height: 100 }, 0.2, "selection_input")).toMatchObject({ selectionBounds: { left: 0, top: 0, right: 5, bottom: 4 }, clipToSelection: false }); });
  it("rejects empty, tiny-zero-area, or fully off-canvas selections", () => { expect(() => createSelectionPlan({ left: 4, top: 4, right: 4, bottom: 5 }, { width: 10, height: 10 })).toThrow("no usable"); expect(() => createSelectionPlan({ left: -5, top: -5, right: -1, bottom: -1 }, { width: 10, height: 10 })).toThrow("outside"); });
});
