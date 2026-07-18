import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas selection actions", () => {
  it("exposes selection collection and isolation as addable buttons and popup menu actions", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");

    expect(source).toContain('{ id: "collectSelected", label: "Create node with selected" }');
    expect(source).toContain('{ id: "keepSelected", label: "Keep only selected" }');
    expect(source).toContain("createNodeWithSelectedElements(nodeId: string)");
    expect(source).toContain("keepOnlySelectedNodes(nodeId: string)");
    expect(source).toContain("sourceNode.manifest.selectedStackItemIds");
    expect(source).toContain('return "text-nodes"');
    expect(source).toContain("textNode.manifest.selectedStackItemIds");
    expect(source).toContain("!selectedIdSet.has(item.id)");
    expect(source).toContain("selectedStackItemIds: []");
    expect(source).toContain('createdNode.canvas.id)}/prompt`, { prompt: "" }');
    expect(source).not.toContain("Could not create collection node.");
  });
});
