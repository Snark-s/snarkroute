import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../../jsx/host.jsx", import.meta.url)), "utf8");

describe("After Effects host placeholder", () => {
  it("uses a SolidSource FootageItem and never imports an empty placeholder file", () => {
    expect(source).toContain("layers.addSolid(");
    expect(source).not.toContain("importPlaceholder(");
    expect(source).not.toMatch(/new File\([^)]*(empty|placeholder)/i);
  });

  it("replaces the existing FootageItem source without replacing the layer", () => {
    expect(source).toContain("footage.replace(new File(resultPath))");
    expect(source).not.toContain("layer.replaceSource(");
    expect(source).not.toContain("layer.remove(");
  });
});
