import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas image drawing editor", () => {
  it("provides brush, eraser, text, color and diameter controls", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");

    expect(source).toContain('{ id: "draw", label: "Draw" }');
    expect(source).toContain('type DrawingTool = "brush" | "eraser" | "text"');
    expect(source).toContain('type="color" value={color}');
    expect(source).toContain('type="range" min="2" max="120"');
    expect(source).toContain('globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over"');
    expect(source).toContain("context.fillText(textValue.trim(), point.x, point.y)");
    expect(source).toContain('event.code !== "BracketLeft" && event.code !== "BracketRight"');
    expect(source).toContain('event.code === "BracketLeft" ? -5 : 5');
    expect(source).toContain('className={`drawingBrushCursor is-${tool}`}');
    expect(source).toContain("diameter * brushCursor.scale");
    expect(source).toContain('image: ["download", "crop", "draw", "expand"]');
    expect(source).not.toContain('node.manifest.type === "image" && !toolbarActions.includes("draw")');
  });

  it("creates a connected image node and appends later edits to its stack", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");

    expect(source).toContain('kind?: "representation" | "crop" | "imageCorrection" | "drawing"');
    expect(source).toContain('edge.kind === "drawing"');
    expect(source).toContain('title="Modify drawing"');
    expect(source).toContain("draft.targetNodeId");
    expect(source).toContain('kind: "drawing"');
    expect(source).toContain('setStatus(draft.targetNodeId ? "Drawing added to stack" : "Drawing created")');
    expect(source).toContain("drawingSourceStackItemId !== sourceNode?.activeStackItem?.id");
    expect(source).toContain("drawingSourceStackItemId?: string");
  });
});
