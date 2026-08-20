import { describe, expect, it } from "vitest";
import { afterEffectsToolSupport, defaultToolValues, manualToolInputs, normalizeToolValues, sourceForAfterEffects, validateToolValues, type PortableToolSchema } from "./schema";

const tool: PortableToolSchema = {
  schemaVersion: "1.0", id: "portable.video", title: "Portable video", version: "1.0.0", action: { kind: "node", value: "portable.video" },
  inputs: [{ id: "frame", type: "image", required: true, source: "host_selection", hostSources: { after_effects: "host_current_frame" } }, { id: "prompt", type: "multiline_text", required: true, source: "manual" }],
  outputs: [{ id: "video", type: "video", placement: "replace_placeholder" }],
  params: [{ id: "duration", type: "duration", default: 5, min: 1, max: 10 }, { id: "quality", type: "select", default: 2, options: [{ value: 1 }, { value: 2 }] }],
  hosts: [{ host: "after_effects", sources: ["host_current_frame", "manual"], placements: ["replace_placeholder"] }],
  job: { states: ["queued", "generating", "completed", "failed"], cancellable: true, retryable: true, selectableResults: true }
};

describe("portable AE tool mapping", () => {
  it("uses host-specific capture mappings and builds deterministic defaults", () => { expect(sourceForAfterEffects(tool.inputs[0])).toBe("host_current_frame"); expect(defaultToolValues(tool)).toEqual({ duration: 5, quality: 2, prompt: "" }); expect(afterEffectsToolSupport(tool)).toEqual({ supported: true, reasons: [] }); });
  it("coerces rendered controls back to schema types and maps manual inputs", () => { const values = { duration: "7", quality: "1", prompt: "move" }; expect(normalizeToolValues(tool, values)).toEqual({ duration: 7, quality: 1 }); expect(manualToolInputs(tool, values)).toEqual({ prompt: { type: "text", text: "move" } }); });
  it("reports range, required, and unsupported host capability errors", () => { expect(validateToolValues(tool, { duration: 20, quality: 2, prompt: "" })).toEqual(["duration must be at most 10.", "prompt is required."]); const unsupported = { ...tool, inputs: [{ ...tool.inputs[0], hostSources: { after_effects: "host_work_area" as const } }] }; expect(afterEffectsToolSupport(unsupported).supported).toBe(false); });
});
