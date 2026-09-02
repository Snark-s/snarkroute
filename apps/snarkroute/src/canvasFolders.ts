export interface FolderCanvasNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasFolder {
  id: string;
  title: string;
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
  nodeOffsets?: Record<string, { x: number; y: number }>;
}

const folderPaddingX = 28;
const folderPaddingBottom = 28;
const folderHeaderHeight = 52;

export function createCanvasFolder(id: string, title: string, nodes: FolderCanvasNode[]): CanvasFolder {
  if (nodes.length < 2) throw new Error("A canvas folder needs at least two nodes.");
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return {
    id,
    title,
    nodeIds: nodes.map((node) => node.id),
    x: left - folderPaddingX,
    y: top - folderHeaderHeight,
    width: right - left + folderPaddingX * 2,
    height: bottom - top + folderHeaderHeight + folderPaddingBottom,
    collapsed: false
  };
}

export function placeNodesInFolder(folders: CanvasFolder[], folder: CanvasFolder): CanvasFolder[] {
  const movedIds = new Set(folder.nodeIds);
  const remaining = folders
    .filter((entry) => entry.id !== folder.id)
    .map((entry) => ({ ...entry, nodeIds: entry.nodeIds.filter((nodeId) => !movedIds.has(nodeId)) }))
    .filter((entry) => entry.nodeIds.length > 0);
  return [...remaining, folder];
}

export function hiddenCanvasNodeIds(folders: CanvasFolder[]): Set<string> {
  return new Set(folders.filter((folder) => folder.collapsed).flatMap((folder) => folder.nodeIds));
}

export function collapseCanvasFolder(folder: CanvasFolder, nodes: FolderCanvasNode[]): CanvasFolder {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return {
    ...folder,
    collapsed: true,
    nodeOffsets: Object.fromEntries(folder.nodeIds.flatMap((nodeId) => {
      const node = nodeById.get(nodeId);
      return node ? [[nodeId, { x: node.x - folder.x, y: node.y - folder.y }]] : [];
    }))
  };
}

export function expandCanvasFolder(folder: CanvasFolder): {
  folder: CanvasFolder;
  nodePositions: Array<{ id: string; x: number; y: number }>;
} {
  const nodePositions = folder.nodeIds.flatMap((nodeId) => {
    const offset = folder.nodeOffsets?.[nodeId];
    return offset ? [{ id: nodeId, x: folder.x + offset.x, y: folder.y + offset.y }] : [];
  });
  const { nodeOffsets: _nodeOffsets, ...expandedFolder } = folder;
  return { folder: { ...expandedFolder, collapsed: false }, nodePositions };
}

export function folderAwareEdgeVisible(
  edge: { fromNodeId: string; toNodeId: string; fromPinned?: boolean },
  hiddenNodeIds: Set<string>,
  pinnedNodeIds: Set<string>,
  dockedCollectionIds: Set<string>
): boolean {
  const sourceVisible = !hiddenNodeIds.has(edge.fromNodeId)
    || (edge.fromPinned === true && pinnedNodeIds.has(edge.fromNodeId));
  const targetVisible = !hiddenNodeIds.has(edge.toNodeId)
    || dockedCollectionIds.has(edge.toNodeId);
  return sourceVisible && targetVisible;
}
