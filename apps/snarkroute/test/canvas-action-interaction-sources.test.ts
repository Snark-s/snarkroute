import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("interactive canvas actions", () => {
  it("keeps pose fields synchronized and reuses edge intermediates", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");
    const styles = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

    expect(source).toContain("reuse: Boolean(targetNodeId)");
    expect(source).toContain("const runParams = params;");
    expect(source).toContain('return !param.poseManaged || axis === "fov"');
    expect(source).toContain("yaw {Math.round(view.yaw * 180 / Math.PI)}° · pitch");
    expect(source).toContain("syncCanvasActionPose(canvasActionRunDialog, { fov: clamp(Number(value), 1, 120) })");
    expect(source).toContain("<BusyGears /> Running...");
    expect(source).toContain(">Prepare again</button>");
    expect(styles).toContain('.canvasActionPanoramaViewer input[type="range"]::-webkit-slider-runnable-track');
    expect(styles).toContain(".canvasActionSplatViewer {\n  max-height: 50vh;\n  overflow: hidden;");
    expect(styles).toContain("object-fit: contain;\n  border-radius: 12px 12px 0 0;");
    expect(styles.match(/\.canvasActionPanoramaViewer,\s*\.canvasActionSplatViewer\s*\{[^}]*\}/)?.[0]).not.toContain("max-height");
    expect(styles.match(/\.canvasActionPanoramaViewer,\s*\.canvasActionSplatViewer\s*\{[^}]*\}/)?.[0]).not.toContain("overflow");
  });
});
