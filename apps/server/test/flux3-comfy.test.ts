import { describe, expect, it } from "vitest";
import { fillWorkflow, flux3Status, parseWorkflow } from "../src/providers/flux3-comfy";

const API = JSON.stringify({
  "1": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}" } },
  "2": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: "{{steps}}", width: "{{width}}", height: "{{height}}" } },
  "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } }
});

describe("local FLUX.3 ComfyUI adapter", () => {
  it("parses a trusted API-format workflow and fills typed parameters", () => {
    const source = parseWorkflow(API);
    const result = fillWorkflow(source, { prompt: "a fox", seed: 42, steps: 16, width: 1024, height: 768 });
    expect(result["1"].inputs.text).toBe("a fox");
    expect(result["2"].inputs.seed).toBe(42);
    expect(result["2"].inputs.steps).toBe(16);
    expect(result["2"].inputs.width).toBe(1024);
    expect(source["2"].inputs.seed).toBe("{{seed}}");
  });
  it("refuses non-API format and missing output node", () => {
    expect(() => parseWorkflow('[]')).toThrow("API-format");
    expect(() => parseWorkflow('{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}}}')).toThrow("SaveImage");
  });
  it("refuses missing variables and mixed string placeholders", () => {
    const source = parseWorkflow(API);
    expect(() => fillWorkflow(source, { prompt: "test" })).toThrow("Missing workflow value");
    const invalid = { ...source, "1": { ...source["1"], inputs: { text: "prefix {{prompt}}" } } };
    expect(() => fillWorkflow(invalid, { prompt: "test", seed: 1, steps: 16, width: 512, height: 512 })).toThrow("whole input");
  });
  it("keeps model unavailable when no trusted workflow was configured", async () => {
    const result = await flux3Status({ env: { FLUX3_COMFY_URL: "http://127.0.0.1:8188" } });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/WORKFLOW_PATH/);
  });
  it("rejects non-loopback ComfyUI endpoints", async () => {
    await expect(flux3Status({ env: { FLUX3_COMFY_URL: "http://example.com:8188" } })).rejects.toThrow("loopback");
  });
});