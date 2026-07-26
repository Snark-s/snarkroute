import { describe, expect, it } from "vitest";
import {
  edgePath,
  pinnedNodeEdgePath,
  pinnedSourceEdgePath,
  setConnectionPinnedSource,
  togglePinnedNodeState
} from "./pinnedNodes";

describe("pinned nodes", () => {
  it("routes pinned edges down from the dock and into the target from the left", () => {
    const start = { x: 120, y: 20 };
    const end = { x: 480, y: 300 };
    const path = pinnedNodeEdgePath(start, end);
    const match = path.match(/^M \S+ \S+ C (\S+) (\S+), (\S+) (\S+), \S+ \S+$/);

    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBeGreaterThan(start.y);
    expect(Number(match?.[3])).toBeLessThan(end.x);
  });

  it("pins a node, then unpins it without deleting edges and clears pinned sources", () => {
    const edges = [
      { id: "edge-a", fromNodeId: "node-a", toNodeId: "node-b", fromPinned: true },
      { id: "edge-b", fromNodeId: "node-a", toNodeId: "node-c", fromPinned: true },
      { id: "edge-c", fromNodeId: "node-b", toNodeId: "node-a", fromPinned: true }
    ];
    const pinned = togglePinnedNodeState([], edges, "node-a", "image");
    const unpinned = togglePinnedNodeState(pinned.pinnedNodeIds, pinned.edges, "node-a", "image");

    expect(pinned.pinnedNodeIds).toEqual(["node-a"]);
    expect(unpinned.pinnedNodeIds).toEqual([]);
    expect(unpinned.edges).toHaveLength(edges.length);
    expect(unpinned.edges.filter((edge) => edge.fromNodeId === "node-a").every((edge) => edge.fromPinned === undefined)).toBe(true);
    expect(unpinned.edges.find((edge) => edge.id === "edge-c")?.fromPinned).toBe(true);
  });

  it("falls back to the original node path when a pinned source is not persisted", () => {
    const edge = { fromNodeId: "node-a", fromPinned: true };
    const start = { x: 100, y: 200 };
    const pinnedStart = { x: 220, y: 20 };
    const end = { x: 500, y: 240 };

    expect(pinnedSourceEdgePath(edge, [], start, end, pinnedStart)).toBe(edgePath(start, end));
    expect(pinnedSourceEdgePath(edge, ["node-a"], start, end, pinnedStart)).toBe(pinnedNodeEdgePath(pinnedStart, end));
  });

  it("does not pin collections through the node toggle", () => {
    const edges = [{ id: "edge-a", fromNodeId: "collection-a", toNodeId: "node-b" }];
    const result = togglePinnedNodeState([], edges, "collection-a", "collection");

    expect(result.blocked).toBe(true);
    expect(result.pinnedNodeIds).toEqual([]);
    expect(result.edges).toBe(edges);
  });

  it("keeps the proxy source when a connected node is created", () => {
    const edges = [
      { id: "edge-a", fromNodeId: "node-a", toNodeId: "node-b" },
      { id: "edge-b", fromNodeId: "node-c", toNodeId: "node-d" }
    ];

    expect(setConnectionPinnedSource(edges, "node-a", "node-b")).toEqual([
      { ...edges[0], fromPinned: true },
      edges[1]
    ]);
  });
});
