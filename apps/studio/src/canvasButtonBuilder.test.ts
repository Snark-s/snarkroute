import { describe, expect, it } from "vitest";
import {
  canvasButtonManifestFromDraft,
  canvasButtonParamCandidates,
  canvasButtonPreviewCandidates,
  compoundBrandeshmygActionEligible,
  compoundCanvasButtonEligible,
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
  it("keeps Living Canvas buttons single-input", () => {
    const compound = compoundWith([], [{ id: "video", nodeId: "kling", kind: "video" }]);
    compound.compound!.inputs = [
      { id: "startImage", nodeId: "kling", kind: "image" },
      { id: "endImage", nodeId: "kling", kind: "image" }
    ];
    expect(compoundCanvasButtonEligible(compound)).toBe(false);
    compound.compound!.inputs = [{ id: "startImage", nodeId: "kling", kind: "image" }];
    expect(compoundCanvasButtonEligible(compound)).toBe(true);
  });

  it("allows Brandeshmyg actions with multiple mixed input types", () => {
    const compound = compoundWith([], [{ id: "video", nodeId: "kling", kind: "video" }]);
    compound.compound!.inputs = [
      { id: "startImage", nodeId: "kling", kind: "image" },
      { id: "endImage", nodeId: "kling", kind: "image" },
      { id: "prompt", nodeId: "kling", kind: "text" }
    ];
    expect(compoundBrandeshmygActionEligible(compound)).toBe(true);
    const draft: CanvasButtonDraft = {
      nodeId: "compound", title: "Kling", packageId: "kling-action", iconName: "video", inputKind: "image",
      surface: "brandeshmyg", outputs: [], params: [], previewCandidates: [], selectedPreviewId: ""
    };
    expect(canvasButtonManifestFromDraft(draft, compound)?.canvasAction?.surface).toBe("brandeshmyg");
  });

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
      expect.objectContaining({ id: "upscale.resemblance", type: "number", default: 1.5, displayLabel: "resemblance" })
    ]));
  });

  it("preserves declared list options for generated action parameters", () => {
    const compound = compoundWith([
      { id: "video", type: "polza.video.generate", params: { resolution: "720p" } }
    ], [{ id: "video", nodeId: "video", kind: "video" }]);
    const [resolution] = canvasButtonParamCandidates(compound, [{
      id: "polza.video.generate", title: "Polza Video", version: "0.1", author: { name: "Test" }, origin: "bundled", license: "AGPL",
      permissions: { network: true, readFiles: true, writeOutputs: true, shell: false, env: [] },
      executor: { type: "builtin" }, inputs: [], outputs: [],
      params: [{ id: "resolution", type: "text", default: "720p", options: [{ value: "720p" }, { value: "1080p" }] }]
    }], []);
    expect(resolution.options).toEqual([{ value: "720p" }, { value: "1080p" }]);
  });

  it("filters runtime, structured, and timestamp parameters that are not declared", () => {
    const compound = compoundWith([{
      id: "upscale",
      type: "replicate.clarity-upscaler",
      params: {
        pinnedOutput: { id: "asset" },
        pinnedOutputAt: "2026-07-02T01:02:03.000Z",
        pollingIntervalMs: 500,
        timeoutMs: 30_000,
        scale_factor: 2
      }
    }], [{ id: "image", nodeId: "upscale", kind: "image" }]);

    expect(canvasButtonParamCandidates(compound, [], []).map((param) => param.displayLabel)).toEqual(["scale_factor"]);
  });

  it("writes a panorama node preview candidate without an exposed output", () => {
    const compound = compoundWith([
      { id: "upscale", type: "replicate.clarity-upscaler", title: "Clarity Upscaler", params: {} },
      { id: "pano", type: "preview.panorama360", title: "Room Viewer", params: { fov: 55 } }
    ], [{ id: "image", nodeId: "upscale", kind: "image", label: "Enhanced" }]);
    const previewCandidates = canvasButtonPreviewCandidates(compound, "image");
    const panorama = previewCandidates.find((candidate) => candidate.kind === "panorama360");
    expect(panorama).toMatchObject({ label: "Room Viewer (360)", source: { pause: "pano" } });
    const params = canvasButtonParamCandidates(compound, [{ id: "preview.panorama360", title: "360", version: "0.1", author: { name: "Test" }, origin: "bundled", license: "AGPL", permissions: { network: false, readFiles: false, writeOutputs: false, shell: false, env: [] }, executor: { type: "builtin" }, inputs: [], outputs: [], params: [{ id: "yaw", type: "number", default: 0 }, { id: "pitch", type: "number", default: 0 }, { id: "fov", type: "number", default: 55 }] }], []);
    const draft: CanvasButtonDraft = {
      nodeId: "compound", title: "Enhance", packageId: "enhance", iconName: "wrench", inputKind: "image",
      outputs: [], params, previewCandidates, selectedPreviewId: defaultCanvasButtonPreviewId(previewCandidates)
    };
    expect(canvasButtonManifestFromDraft(draft, compound)?.canvasAction?.dialog?.preview).toEqual([
      { kind: "panorama360", source: { pause: "pano" } }
    ]);
    expect(canvasButtonManifestFromDraft(draft, compound)?.canvasAction?.poseBindings).toEqual({ yaw: "pano.yaw", pitch: "pano.pitch", fov: "pano.fov" });
    expect(canvasButtonManifestFromDraft(draft, compound)?.params).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pano.yaw", poseManaged: true }),
      expect.objectContaining({ id: "pano.pitch", poseManaged: true }),
      expect.objectContaining({ id: "pano.fov", poseManaged: true })
    ]));
  });

  it("keeps exposed output preview candidates", () => {
    const candidates = canvasButtonPreviewCandidates(compoundWith([], [{ id: "image", nodeId: "upscale", kind: "image", label: "Enhanced" }]), "text");
    expect(candidates).toContainEqual({ id: "output:image", kind: "image", source: { output: "image" }, label: "Enhanced" });
  });

  it("publishes a host-neutral tool schema for BoojumRoute, After Effects, and compatible Photoshop selections", () => {
    const compound = compoundWith([], [{ id: "image", nodeId: "enhance", kind: "image", label: "Enhanced" }]);
    const draft: CanvasButtonDraft = { nodeId: "compound", title: "Enhance", packageId: "enhance", iconName: "wrench", inputKind: "image", outputs: [], params: [], previewCandidates: [], selectedPreviewId: "" };
    const tool = canvasButtonManifestFromDraft(draft, compound)?.tool as { inputs: Array<{ hostSources: Record<string, string>; contextPadding?: number }>; outputs: Array<{ hostPlacements: Record<string, string>; clipToSelection?: boolean }>; hosts: Array<{ host: string }> };
    expect(tool.hosts.map((host) => host.host)).toEqual(["boojumroute", "after_effects", "photoshop"]);
    expect(tool.inputs[0]).toMatchObject({ hostSources: { after_effects: "host_current_frame", photoshop: "photoshop_selection" }, contextPadding: 0.2 });
    expect(tool.outputs[0]).toMatchObject({ hostPlacements: { after_effects: "replace_placeholder", photoshop: "selection_layer" }, clipToSelection: true });
  });

  it("automatically manages a splat cameraPose parameter", () => {
    const compound = compoundWith([{ id: "splat", type: "preview.splat", title: "Splat", params: {} }], [{ id: "image", nodeId: "splat", kind: "image" }]);
    const previewCandidates = canvasButtonPreviewCandidates(compound, "image");
    const params = canvasButtonParamCandidates(compound, [{ id: "preview.splat", title: "Splat", version: "0.1", author: { name: "Test" }, origin: "bundled", license: "AGPL", permissions: { network: false, readFiles: false, writeOutputs: false, shell: false, env: [] }, executor: { type: "builtin" }, inputs: [], outputs: [], params: [{ id: "cameraPose", type: "json", default: { position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0, roll: 0 }, fov: 70 } }] }], []);
    const draft: CanvasButtonDraft = { nodeId: "compound", title: "Splat view", packageId: "splat-view", iconName: "wrench", inputKind: "image", outputs: [], params, previewCandidates, selectedPreviewId: previewCandidates.find((candidate) => candidate.kind === "splat")!.id };
    expect(canvasButtonManifestFromDraft(draft, compound)).toMatchObject({
      params: [expect.objectContaining({ id: "splat.cameraPose", poseManaged: true })],
      canvasAction: { poseBindings: { cameraPose: "splat.cameraPose" } }
    });
  });

  it("derives pose bindings for selected fisheye camera parameters", () => {
    const compound = compoundWith([{ id: "fisheye", type: "transform.panorama360ToFisheye", params: { yawDegrees: 0, pitchDegrees: -90, fovDegrees: 200 } }], [{ id: "image", nodeId: "fisheye", kind: "image" }]);
    const params = canvasButtonParamCandidates(compound, [], []).map((param) => ({ ...param, selected: true }));
    const draft: CanvasButtonDraft = { nodeId: "compound", title: "Look", packageId: "look", iconName: "wrench", inputKind: "image", outputs: [], params, previewCandidates: [], selectedPreviewId: "" };
    expect(canvasButtonManifestFromDraft(draft, compound)?.canvasAction?.poseBindings).toEqual({ yaw: "fisheye.yawDegrees", pitch: "fisheye.pitchDegrees", fov: "fisheye.fovDegrees" });
  });
});
