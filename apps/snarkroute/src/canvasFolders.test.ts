import { describe, expect, it } from "vitest";
import {
  collapseCanvasFolder,
  createCanvasFolder,
  expandCanvasFolder,
  folderAwareEdgeVisible,
  hiddenCanvasNodeIds,
  placeNodesInFolder,
  type CanvasFolder,
  type FolderCanvasNode
} from "./canvasFolders";

const nodes: FolderCanvasNode[] = [
  { id: "a", x: 100, y: 120, width: 240, height: 180 },
  { id: "b", x: 420, y: 180, width: 200, height: 160 }
];

describe("canvas folders", () => {
  it("creates a padded folder around the selected nodes", () => {
    const folder = createCanvasFolder("folder-1", "References", nodes);

    expect(folder.nodeIds).toEqual(["a", "b"]);
    expect(folder.x).toBeLessThan(nodes[0].x);
    expect(folder.y).toBeLessThan(nodes[0].y);
    expect(folder.x + folder.width).toBeGreaterThan(nodes[1].x + nodes[1].width);
    expect(folder.y + folder.height).toBeGreaterThan(nodes[1].y + nodes[1].height);
  });

  it("moves selected nodes out of older folders without touching other members", () => {
    const existing: CanvasFolder[] = [
      { id: "old", title: "Old", nodeIds: ["a", "c"], x: 0, y: 0, width: 400, height: 300, collapsed: false }
    ];
    const next = placeNodesInFolder(existing, createCanvasFolder("new", "New", nodes));

    expect(next.find((folder) => folder.id === "old")?.nodeIds).toEqual(["c"]);
    expect(next.find((folder) => folder.id === "new")?.nodeIds).toEqual(["a", "b"]);
  });

  it("hides collapsed folder members without mutating the source node list", () => {
    const folders: CanvasFolder[] = [
      { id: "folder-1", title: "Folder", nodeIds: ["a", "b"], x: 0, y: 0, width: 400, height: 300, collapsed: true }
    ];

    expect([...hiddenCanvasNodeIds(folders)]).toEqual(["a", "b"]);
    expect(nodes.map((node) => node.id)).toEqual(["a", "b"]);
  });

  it("restores members relative to a collapsed folder after it moves", () => {
    const collapsed = collapseCanvasFolder(createCanvasFolder("folder-1", "Folder", nodes), nodes);
    const moved = { ...collapsed, x: collapsed.x + 180, y: collapsed.y - 40 };

    const expanded = expandCanvasFolder(moved);

    expect(expanded.folder.collapsed).toBe(false);
    expect(expanded.folder.nodeOffsets).toBeUndefined();
    expect(expanded.nodePositions).toEqual([
      { id: "a", x: nodes[0].x + 180, y: nodes[0].y - 40 },
      { id: "b", x: nodes[1].x + 180, y: nodes[1].y - 40 }
    ]);
  });

  it("keeps panel-routed edges while hiding ordinary edges from collapsed members", () => {
    const hidden = new Set(["a", "b"]);

    expect(folderAwareEdgeVisible(
      { fromNodeId: "a", toNodeId: "outside", fromPinned: true },
      hidden,
      new Set(["a"]),
      new Set()
    )).toBe(true);
    expect(folderAwareEdgeVisible(
      { fromNodeId: "outside", toNodeId: "b" },
      hidden,
      new Set(),
      new Set(["b"])
    )).toBe(true);
    expect(folderAwareEdgeVisible(
      { fromNodeId: "a", toNodeId: "outside" },
      hidden,
      new Set(["a"]),
      new Set()
    )).toBe(false);
  });
});
