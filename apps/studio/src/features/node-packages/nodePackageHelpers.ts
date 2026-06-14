import { LIBRARY_NODE_METADATA_STORAGE_KEY, libraryNodeStatuses } from "../../studioConfig";
import type { LibraryNodeMetadata, LibraryNodeStatus, NodeManifest } from "../../studioTypes";

export function loadLibraryNodeMetadata(): LibraryNodeMetadata {
  try {
    const text = localStorage.getItem(LIBRARY_NODE_METADATA_STORAGE_KEY);
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([id, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as { status?: unknown; order?: unknown };
        const status = isLibraryNodeStatus(record.status) ? record.status : undefined;
        const order = typeof record.order === "number" && Number.isFinite(record.order) ? record.order : undefined;
        return [[id, { status, order }]];
      })
    );
  } catch {
    return {};
  }
}

export function saveLibraryNodeMetadata(metadata: LibraryNodeMetadata): void {
  try {
    localStorage.setItem(LIBRARY_NODE_METADATA_STORAGE_KEY, JSON.stringify(metadata));
  } catch {
    // Metadata is a UI convenience; route editing should keep working if storage is unavailable.
  }
}

export function isLibraryNodeStatus(value: unknown): value is LibraryNodeStatus {
  return typeof value === "string" && libraryNodeStatuses.some((status) => status.id === value);
}

export function libraryNodeStatusLabel(status: LibraryNodeStatus): string {
  return libraryNodeStatuses.find((item) => item.id === status)?.label ?? status;
}

export function defaultLibraryNodeStatus(node: NodeManifest): LibraryNodeStatus {
  return node.enabled === false ? "archived" : "candidate";
}

export function libraryNodeStatus(node: NodeManifest, metadata: LibraryNodeMetadata): LibraryNodeStatus {
  return metadata[node.id]?.status ?? defaultLibraryNodeStatus(node);
}

export function libraryNodeOrder(node: NodeManifest, metadata: LibraryNodeMetadata, fallbackOrder: number): number {
  return metadata[node.id]?.order ?? fallbackOrder;
}
