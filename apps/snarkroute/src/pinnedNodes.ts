export interface PinnedSourceEdge {
  fromNodeId: string;
  fromPinned?: boolean;
}

export interface ConnectedPinnedSourceEdge extends PinnedSourceEdge {
  toNodeId: string;
}

export interface Point {
  x: number;
  y: number;
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

export function edgePath(start: Point, end: Point): string {
  const distance = Math.max(80, Math.abs(end.x - start.x) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + distance} ${start.y}, ${end.x - distance} ${end.y}, ${end.x} ${end.y}`;
}

export function pinnedNodeEdgePath(start: Point, end: Point): string {
  const verticalDeparture = Math.max(70, Math.min(180, Math.abs(end.y - start.y) * 0.4));
  return `M ${start.x} ${start.y} C ${start.x} ${start.y + verticalDeparture}, ${end.x - 80} ${end.y}, ${end.x} ${end.y}`;
}

export function pinnedSourceEdgePath(
  edge: PinnedSourceEdge,
  pinnedNodeIds: string[],
  start: Point,
  end: Point,
  pinnedStart: Point
): string {
  return edge.fromPinned && pinnedNodeIds.includes(edge.fromNodeId)
    ? pinnedNodeEdgePath(pinnedStart, end)
    : edgePath(start, end);
}

export function setConnectionPinnedSource<T extends ConnectedPinnedSourceEdge>(
  edges: T[],
  fromNodeId: string,
  toNodeId: string
): T[] {
  return edges.map((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId
    ? { ...edge, fromPinned: true }
    : edge);
}
