import { describe, expect, it } from "vitest";
import {
  canvasButtonManifestFromDraft,
  canvasButtonParamCandidates,
  canvasButtonPreviewCandidates,
  defaultCanvasButtonPreviewId,
  type CanvasButtonDraft
} from "./canvasButtonBuilder";
import type { RouteDoc } from "./studioTypes";

function compoundWith(nodes: RouteDoc["nodes"], outputs: NonNullable<RouteDoc["nodes"][number]["compound"]>["outputs"]): RouteDoc["nodes"][number] {
  return {
    id: "compound",
    type: "compound.subroute",
    title: "Enhance",
    compound: { title: "Enhance", inputs: [{ id: "image", nodeId: "upscale", kind: "image" }], outputs },
    subroute: { routeVersion: "0.1", route: { id: "sub", title: "Sub", author: {} }, nodes, edges: [] }
  };
}

describe("Living Canvas button builder", () => {
  it("derives built-in parameter candidates from node values and type defaults", () => {
    const compound = compoundWith([
      { id: "upscale", type: "replicate.clarity-upscaler", title: "Clarity Upscaler", params: { scale_factor: 4, creativity: 0.4 } }
    ], [{ id: "image", nodeId: "upscale", kind: "image" }]);
    const candidates = canvasButtonParamCandidates(compound, [], [{
      type: "replicate.clarity-upscaler",
      params: { scale_factor: 2, creativity: 0.25, resemblance: 1.5 }
    }]);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "upscale.scale_factor", type: "number", default: 4, binding: { nodeId: "upscale", paramId: "scale_factor" } }),
      expect.objectContaining({ id: "upscale.creativity", type: "number", default: 0.4 }),
      expect.objectContaining({ id: "upscale.resemblance", type: "number", default: 1.5, displayLabel: "Clarity Upscaler — resemblance" })
    ]));
  });

  it("writes a panorama node preview candidate into the canvas action manifest", () => {
    const compound = compoundWith([
      { id: "upscale", type: "replicate.clarity-upscaler", title: "Clarity Upscaler", params: {} },
      { id: "pano", type: "preview.panorama360", title: "Room Viewer", params: { fov: 55 } }
    ], [
      { id: "image", nodeId: "upscale", kind: "image", label: "Enhanced" },
      { id: "panorama", nodeId: "pano", kind: "image", label: "Panorama" }
    ]);
    const previewCandidates = canvasButtonPreviewCandidates(compound, "image");
    const panorama = previewCandidates.find((candidate) => candidate.kind === "panorama360");
    expect(panorama).toMatchObject({ label: "Room Viewer (360)", source: { output: "panorama" } });
    const draft: CanvasButtonDraft = {
      nodeId: "compound", title: "Enhance", packageId: "enhance", iconName: "wrench", inputKind: "image",
      outputs: [], params: [], previewCandidates, selectedPreviewId: defaultCanvasButtonPreviewId(previewCandidates)
    };
    expect(canvasButtonManifestFromDraft(draft, compound)?.canvasAction?.dialog?.preview).toEqual([
      { kind: "panorama360", source: { output: "panorama" } }
    ]);
  });
});
