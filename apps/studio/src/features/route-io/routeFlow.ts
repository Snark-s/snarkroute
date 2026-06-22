import type { Edge, Node } from "@xyflow/react";
import { SUBROUTE_INPUT_NODE_ID, SUBROUTE_OUTPUT_NODE_ID } from "../../studioConfig";
import type { CompoundPortMapping, RouteDoc, SubrouteFrame } from "../../studioTypes";

export function routeToFlow(route: RouteDoc): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: route.nodes.map((node, index) => ({
      id: node.id,
      type: isCompoundInterfaceType(node.type) ? "interface" : "route",
      position: { x: Number(node.ui?.x ?? 80 + index * 240), y: Number(node.ui?.y ?? 120) },
      data: { label: `${node.title ?? node.id}\n${node.type}`, routeNode: node }
    })),
    edges: route.edges.map((edge, index) => ({
      id: edge.id ?? `${edge.from}-${edge.fromPort ?? "output"}-${edge.to}-${edge.toPort ?? "input"}-${index}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.fromPort,
      targetHandle: edge.toPort
    }))
  };
}


export function routeNodeParamsCollapsed(node: RouteDoc["nodes"][number] | undefined): boolean {
  return node?.ui?.paramsCollapsed === true;
}

export function withRouteNodeParamsCollapsed(
  node: RouteDoc["nodes"][number],
  collapsed: boolean
): RouteDoc["nodes"][number] {
  const { paramsCollapsed: _paramsCollapsed, ...ui } = node.ui ?? {};
  return {
    ...node,
    ui: collapsed ? { ...ui, paramsCollapsed: true } : ui
  };
}

export function layoutBatchPosition(
  origin: { x: number; y: number },
  index: number
): { x: number; y: number } {
  const columns = 3;
  return {
    x: origin.x + (index % columns) * 300,
    y: origin.y + Math.floor(index / columns) * 220
  };
}

export function routeToEditableSubrouteFlow(route: RouteDoc, compound: RouteDoc["nodes"][number]): { nodes: Node[]; edges: Edge[] } {
  const flow = routeToFlow(route);
  const usedNodeIds = new Set(flow.nodes.map((node) => node.id));
  const usedEdgeIds = new Set(flow.edges.map((edge) => edge.id));
  const xPositions = flow.nodes.map((node) => node.position.x);
  const minX = xPositions.length ? Math.min(...xPositions) : 80;
  const maxX = xPositions.length ? Math.max(...xPositions) : 480;
  const inputNodes = (compound.compound?.inputs ?? []).map((port, index) => {
    const id = uniqueFlowId(`input_${port.id}`, usedNodeIds);
    const routeNode: RouteDoc["nodes"][number] = {
      id,
      type: "compound.input",
      title: port.label ?? port.id,
      params: { portId: port.id, kind: port.kind ?? "data" },
      ui: { x: minX - 340, y: 80 + index * 120 }
    };
    return { id, type: "interface", position: { x: Number(routeNode.ui?.x), y: Number(routeNode.ui?.y) }, data: { label: `${routeNode.title}\n${routeNode.type}`, routeNode } } as Node;
  });
  const outputNodes = (compound.compound?.outputs ?? []).map((port, index) => {
    const id = uniqueFlowId(`output_${port.id}`, usedNodeIds);
    const routeNode: RouteDoc["nodes"][number] = {
      id,
      type: "compound.output",
      title: port.label ?? port.id,
      params: { portId: port.id, kind: port.kind ?? "data" },
      ui: { x: maxX + 340, y: 80 + index * 120 }
    };
    return { id, type: "interface", position: { x: Number(routeNode.ui?.x), y: Number(routeNode.ui?.y) }, data: { label: `${routeNode.title}\n${routeNode.type}`, routeNode } } as Node;
  });
  const inputEdges = inputNodes.flatMap((node) => {
    const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
    const port = (compound.compound?.inputs ?? []).find((entry) => entry.id === routeNode.params?.portId);
    if (!port) return [];
    return compoundMappingTargets(port).map((target) => ({
      id: uniqueFlowId(`${node.id}-${target.nodeId}-${target.port ?? "input"}`, usedEdgeIds),
      source: node.id,
      sourceHandle: "value",
      target: target.nodeId,
      targetHandle: target.port ?? null
    } as Edge));
  });
  const outputEdges = outputNodes.flatMap((node) => {
    const routeNode = node.data.routeNode as RouteDoc["nodes"][number];
    const port = (compound.compound?.outputs ?? []).find((entry) => entry.id === routeNode.params?.portId);
    if (!port) return [];
    return [{
      id: uniqueFlowId(`${port.nodeId}-${port.port ?? "output"}-${node.id}`, usedEdgeIds),
      source: port.nodeId,
      sourceHandle: port.port ?? null,
      target: node.id,
      targetHandle: "value"
    } as Edge];
  });
  return { nodes: [...inputNodes, ...flow.nodes, ...outputNodes], edges: [...inputEdges, ...flow.edges, ...outputEdges] };
}

export function isSubrouteInterfaceId(id?: string | null): boolean {
  return id === SUBROUTE_INPUT_NODE_ID || id === SUBROUTE_OUTPUT_NODE_ID || Boolean(id?.startsWith("__subroute_interface_edge__"));
}

export function subrouteInterfaceKind(id?: string | null): "input" | "output" | null {
  if (id === SUBROUTE_INPUT_NODE_ID) return "input";
  if (id === SUBROUTE_OUTPUT_NODE_ID) return "output";
  return null;
}

export function subrouteInterfaceFlow(nodes: Node[], frame: SubrouteFrame | undefined): { nodes: Node[]; edges: Edge[] } {
  if (!frame) return { nodes: [], edges: [] };
  const compound = frame.parentRoute.nodes.find((node) => node.id === frame.compoundId && node.type === "compound.subroute");
  if (!compound?.compound) return { nodes: [], edges: [] };

  const inputPorts = compound.compound.inputs ?? [];
  const outputPorts = compound.compound.outputs ?? [];
  const xPositions = nodes.map((node) => node.position.x);
  const yPositions = nodes.map((node) => node.position.y);
  const minX = xPositions.length ? Math.min(...xPositions) : 80;
  const maxX = xPositions.length ? Math.max(...xPositions) : 480;
  const minY = yPositions.length ? Math.min(...yPositions) : 120;

  const interfaceNodes: Node[] = [
    {
      id: SUBROUTE_INPUT_NODE_ID,
      type: "interface",
      position: frame.interfacePositions?.input ?? { x: minX - 340, y: minY },
      selectable: false,
      deletable: false,
      data: { kind: "input", ports: inputPorts }
    },
    {
      id: SUBROUTE_OUTPUT_NODE_ID,
      type: "interface",
      position: frame.interfacePositions?.output ?? { x: maxX + 340, y: minY },
      selectable: false,
      deletable: false,
      data: { kind: "output", ports: outputPorts }
    }
  ];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const inputEdges: Edge[] = inputPorts
    .filter((port) => nodeIds.has(port.nodeId))
    .map((port) => ({
      id: `__subroute_interface_edge__input__${port.id}`,
      source: SUBROUTE_INPUT_NODE_ID,
      sourceHandle: port.id,
      target: port.nodeId,
      targetHandle: port.port ?? null,
      selectable: false,
      deletable: false,
      data: { interfaceEdge: true }
    }));
  const outputEdges: Edge[] = outputPorts
    .filter((port) => nodeIds.has(port.nodeId))
    .map((port) => ({
      id: `__subroute_interface_edge__output__${port.id}`,
      source: port.nodeId,
      sourceHandle: port.port ?? null,
      target: SUBROUTE_OUTPUT_NODE_ID,
      targetHandle: port.id,
      selectable: false,
      deletable: false,
      data: { interfaceEdge: true }
    }));

  return { nodes: interfaceNodes, edges: [...inputEdges, ...outputEdges] };
}

export function canImportDroppedRouteFile(file: File): boolean {
  return /\.(orp|opt|route)(\.(json|ya?ml))?$/i.test(file.name) || /\.(json|ya?ml)$/i.test(file.name);
}

export function routeImportFilename(file: File): string {
  return file.name.replace(/\.opt(?=$|\.)/i, ".orp");
}

export function uniqueFlowId(preferredId: string, usedIds: Set<string>): string {
  if (!usedIds.has(preferredId)) {
    usedIds.add(preferredId);
    return preferredId;
  }

  let index = 2;
  let candidate = `${preferredId}_${index}`;
  while (usedIds.has(candidate)) {
    index += 1;
    candidate = `${preferredId}_${index}`;
  }
  usedIds.add(candidate);
  return candidate;
}

export function uniqueCompoundMappings(mappings: CompoundPortMapping[]): CompoundPortMapping[] {
  const used = new Set<string>();
  return mappings.map((mapping) => {
    const id = uniqueFlowId(String(mapping.id || mapping.nodeId).replace(/\W+/g, "_") || "port", used);
    return { ...mapping, id };
  });
}

export function compoundMappingTargets(mapping: CompoundPortMapping): Array<{ nodeId: string; port?: string }> {
  const targets = mapping.targets && mapping.targets.length > 0 ? mapping.targets : [{ nodeId: mapping.nodeId, port: mapping.port }];
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.nodeId}:${target.port ?? "input"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeCompoundInputMappings(mappings: CompoundPortMapping[], keyOf: (mapping: CompoundPortMapping, index: number) => string): CompoundPortMapping[] {
  const usedIds = new Set<string>();
  const merged: CompoundPortMapping[] = [];
  const indexByKey = new Map<string, number>();

  for (const [index, mapping] of mappings.entries()) {
    const key = keyOf(mapping, index);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      const id = uniqueFlowId(String(mapping.id || mapping.nodeId).replace(/\W+/g, "_") || "input", usedIds);
      const targets = compoundMappingTargets(mapping);
      indexByKey.set(key, merged.length);
      merged.push({ ...mapping, id, nodeId: targets[0]?.nodeId ?? mapping.nodeId, port: targets[0]?.port ?? mapping.port, targets: targets.length > 1 ? targets : undefined });
      continue;
    }

    const existing = merged[existingIndex];
    const targets = compoundMappingTargets({ ...existing, targets: [...compoundMappingTargets(existing), ...compoundMappingTargets(mapping)] });
    merged[existingIndex] = { ...existing, nodeId: targets[0]?.nodeId ?? existing.nodeId, port: targets[0]?.port ?? existing.port, targets: targets.length > 1 ? targets : undefined };
  }

  return merged;
}

export function uniqueCompoundMappingsByKey(mappings: CompoundPortMapping[], keyOf: (mapping: CompoundPortMapping) => string): CompoundPortMapping[] {
  const usedIds = new Set<string>();
  const seenKeys = new Set<string>();
  return mappings.flatMap((mapping) => {
    const key = keyOf(mapping);
    if (seenKeys.has(key)) return [];
    seenKeys.add(key);
    const id = uniqueFlowId(String(mapping.id || mapping.nodeId).replace(/\W+/g, "_") || "port", usedIds);
    return [{ ...mapping, id }];
  });
}

export function chooseCompoundPorts(label: string, defaults: CompoundPortMapping[]): CompoundPortMapping[] | null {
  if (defaults.length === 0) return [];
  const value = window.prompt(label, defaults.map((port) => port.id).join(", "));
  if (value === null) return null;
  const selected = new Set(value.split(",").map((part) => part.trim()).filter(Boolean));
  return defaults.filter((port) => selected.has(port.id));
}

function isCompoundInterfaceType(type: string): boolean {
  return type === "compound.input" || type === "compound.output";
}