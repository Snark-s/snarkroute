import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas collapsed node selection", () => {
  it("keeps the selected outline visible while a node is collapsed", () => {
    const styles = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

    expect(styles).toContain(".imageNode.isCollapsed.isSelected .collapsedNodeStrip");
    expect(styles).toContain(".textNode.isCollapsed.isSelected .collapsedNodeStrip");
    expect(styles).toContain("box-shadow: 0 0 0 2px var(--accent)");
  });
});
