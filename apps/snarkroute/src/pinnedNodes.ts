export interface PinnedSourceEdge {
  fromNodeId: string;
  fromPinned?: boolean;
}

export interface PinnedNodeState<T extends PinnedSourceEdge> {
  pinnedNodeIds: string[];
  edges: T[];
  blocked: boolean;
}

export function togglePinnedNodeState<T extends PinnedSourceEdge>(
  pinnedNodeIds: string[],
  edges: T[],
  nodeId: string,
  nodeType?: string
): PinnedNodeState<T> {
  const pinned = pinnedNodeIds.includes(nodeId);
  if (!pinned && nodeType === "collection") {
    return { pinnedNodeIds, edges, blocked: true };
  }

  return {
    pinnedNodeIds: pinned ? pinnedNodeIds.filter((id) => id !== nodeId) : [...pinnedNodeIds, nodeId],
    edges: pinned
      ? edges.map((edge) => edge.fromNodeId === nodeId ? { ...edge, fromPinned: undefined } : edge)
      : edges,
    blocked: false
  };
}
