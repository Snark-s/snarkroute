import { describe, expect, it } from "vitest";
import { canvasActionBoundParams, canvasActionNeedsDialog, createToolTab, initialCanvasActionParams, updateToolTab, visibleCanvasActionParams, type CanvasNodeAction } from "./model.js";

const action: CanvasNodeAction = {
  id: "enhance", title: "Enhance", description: "", inputType: "image", outputs: [{ id: "image", type: "image", label: "Image" }],
  params: [
    { id: "upscale.scale", type: "number", default: 2, binding: { nodeId: "upscale", paramId: "scale" } },
    { id: "hidden.seed", type: "number", default: 7, binding: { nodeId: "hidden", paramId: "seed" } }
  ],
  dialog: { enabled: true, params: ["upscale.scale"] }
};

describe("canvas action host model", () => {
  it("opens a dialog for preview without params", () => {
    expect(canvasActionNeedsDialog({ dialog: { enabled: true, params: [], preview: [{ kind: "panorama360", source: { pause: "viewer" } }] } })).toBe(true);
  });

  it("builds parameters only from dialog.params and maps bindings", () => {
    expect(visibleCanvasActionParams(action).map((param) => param.id)).toEqual(["upscale.scale"]);
    expect(initialCanvasActionParams(action, { "upscale.scale": 4, "hidden.seed": 99 })).toEqual({ "upscale.scale": 4 });
    expect(canvasActionBoundParams(action, { "upscale.scale": 3, "hidden.seed": 99 })).toEqual({ upscale: { scale: 3 } });
  });

  it("keeps two tabs of the same action independent", () => {
    const first = createToolTab(action, "one");
    const second = createToolTab(action, "two");
    const tabs = updateToolTab([first, second], "one", { params: { "upscale.scale": 8 } });
    expect(tabs[0].params).toEqual({ "upscale.scale": 8 });
    expect(tabs[1].params).toEqual({ "upscale.scale": 2 });
  });
});
