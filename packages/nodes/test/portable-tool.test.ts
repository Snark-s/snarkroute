import { describe, expect, it } from "vitest";
import {
  PORTABLE_JOB_STATES,
  migrateLegacyCanvasAction,
  portableToolFromManifest,
  validatePortableToolSchema
} from "../src/index";

const photoshopTool = {
  schemaVersion: "1.0",
  id: "image.replace-selection",
  title: "Replace selection",
  description: "Generate pixels for the selected area.",
  version: "1.0.0",
  action: { kind: "endpoint" as const, value: "/api/tools/image.replace-selection/jobs" },
  inputs: [{ id: "selection", type: "image" as const, required: true, source: "photoshop_selection" as const, acceptedMimes: ["image/png"], includeMask: true, includeComposite: true, contextPadding: 0.2 }],
  outputs: [{ id: "image", type: "image" as const, required: true, placement: "selection_layer" as const, clipToSelection: true, allowSelection: true }],
  params: [{ id: "prompt", type: "multiline_text" as const, required: true }, { id: "seed", type: "seed" as const, default: 0, min: 0, max: 2_147_483_647 }],
  hosts: [{ host: "photoshop" as const, sources: ["photoshop_selection" as const], placements: ["selection_layer" as const], capabilities: ["selection_mask", "selection_bounds"] }],
  job: { states: [...PORTABLE_JOB_STATES], cancellable: true, retryable: true, selectableResults: true }
};

describe("portable tool schema", () => {
  it("validates a Photoshop selection tool without host-specific UI", () => {
    expect(validatePortableToolSchema(photoshopTool)).toMatchObject({ ok: true, tool: { id: "image.replace-selection" } });
  });

  it("reports missing host sources, invalid ranges, and public secrets", () => {
    const validation = validatePortableToolSchema({
      ...photoshopTool,
      inputs: [{ id: "apiKey", type: "image", required: true }],
      params: [{ id: "strength", type: "number", min: 2, max: 1 }]
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["tool.input_source", "tool.range", "tool.secret_exposure"]));
  });

  it("migrates legacy canvas actions and preserves their public contract", () => {
    const tool = migrateLegacyCanvasAction({
      id: "legacy.enhance", title: "Enhance", version: "0.1.0", description: "Legacy action",
      canvasAction: { enabled: true, surface: "livingCanvas", title: "Enhance" },
      inputs: [{ id: "image", type: "image", required: true }],
      outputs: [{ id: "image", type: "image" }],
      params: [{ id: "strength", type: "number", default: 0.5, min: 0, max: 1 }]
    });
    expect(tool).toMatchObject({ id: "legacy.enhance", action: { kind: "node", value: "legacy.enhance" }, inputs: [{ id: "image", source: "host_selection" }], outputs: [{ id: "image", placement: "new_artifact" }], metadata: { migratedFrom: "canvasAction" } });
    expect(validatePortableToolSchema(tool).ok).toBe(true);
  });

  it("does not publish a manifest when a public port or internal mapping is unresolved", () => {
    const result = portableToolFromManifest({
      id: "compound.bad", title: "Bad", version: "1.0.0", tool: { ...photoshopTool, action: { kind: "node", value: "different.node" } },
      inputs: [{ id: "selection", type: "image" }, { id: "missing", type: "image" }], outputs: [{ id: "image", type: "image" }],
      generatedWith: { compound: { inputs: [{ id: "selection", nodeId: "missing-node" }], outputs: [{ id: "image", nodeId: "output" }] }, subroute: { nodes: [{ id: "output", type: "preview.image" }], edges: [] } }
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["tool.unpublished_input", "tool.node_action_mismatch", "tool.unresolved_internal_connection"]));
  });
});
