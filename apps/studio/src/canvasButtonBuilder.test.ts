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

  it("derives pose bindings for selected fisheye camera parameters", () => {
    const compound = compoundWith([{ id: "fisheye", type: "transform.panorama360ToFisheye", params: { yawDegrees: 0, pitchDegrees: -90, fovDegrees: 200 } }], [{ id: "image", nodeId: "fisheye", kind: "image" }]);
    const params = canvasButtonParamCandidates(compound, [], []).map((param) => ({ ...param, selected: true }));
    const draft: CanvasButtonDraft = { nodeId: "compound", title: "Look", packageId: "look", iconName: "wrench", inputKind: "image", outputs: [], params, previewCandidates: [], selectedPreviewId: "" };
    expect(canvasButtonManifestFromDraft(draft, compound)?.canvasAction?.poseBindings).toEqual({ yaw: "fisheye.yawDegrees", pitch: "fisheye.pitchDegrees", fov: "fisheye.fovDegrees" });
  });
});
