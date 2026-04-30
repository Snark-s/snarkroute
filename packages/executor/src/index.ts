import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenRoute, RouteNode } from "@snarkroute/protocol";

export type RunStatus = "pending" | "running" | "succeeded" | "failed";

export interface NodeExecutionContext {
  runId: string;
  route: OpenRoute;
  outputDirectory: string;
  nodeOutputs: Record<string, unknown>;
  log: (message: string, nodeId?: string) => void;
}

export interface NodeRunnerInput {
  node: RouteNode;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
  context: NodeExecutionContext;
}

export interface NodeRunnerResult {
  output: unknown;
  logs?: string[];
  metrics?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export type NodeRunner = (input: NodeRunnerInput) => Promise<NodeRunnerResult> | NodeRunnerResult;

export interface NodeResult {
  nodeId: string;
  type: string;
  status: RunStatus;
  output?: unknown;
  error?: string;
  logs: string[];
  metrics?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export interface RunLogEntry {
  timestamp: string;
  message: string;
  nodeId?: string;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string;
  nodeResults: Record<string, NodeResult>;
  logs: RunLogEntry[];
  provenance: Record<string, unknown>;
  outputDirectory: string;
}

export interface ExecuteOptions {
  runId?: string;
  outputDirectory?: string;
}

export interface RouteExecutor {
  registerNodeRunner: (type: string, runner: NodeRunner) => void;
  executeRoute: (route: OpenRoute, options?: ExecuteOptions) => Promise<RunResult>;
}

export function createExecutor(): RouteExecutor {
  const runners = new Map<string, NodeRunner>();

  return {
    registerNodeRunner(type, runner) {
      runners.set(type, runner);
    },

    async executeRoute(route, options = {}) {
      const runId = options.runId ?? `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const outputDirectory = options.outputDirectory ?? join(process.cwd(), "data", "runs", runId);
      await mkdir(outputDirectory, { recursive: true });

      const startedAt = new Date().toISOString();
      const logs: RunLogEntry[] = [];
      const nodeResults: Record<string, NodeResult> = Object.fromEntries(
        route.nodes.map((node) => [
          node.id,
          {
            nodeId: node.id,
            type: node.type,
            status: "pending" as RunStatus,
            logs: [],
            startedAt: "",
            completedAt: ""
          }
        ])
      );
      const nodeOutputs: Record<string, unknown> = {};
      const log = (message: string, nodeId?: string) => logs.push({ timestamp: new Date().toISOString(), message, nodeId });

      const context: NodeExecutionContext = { runId, route, outputDirectory, nodeOutputs, log };

      try {
        const cycle = detectCycles(route);
        if (cycle.length > 0) {
          throw new Error(`Route contains a cycle: ${cycle.join(" -> ")}`);
        }
        validateTemplateDependencies(route);

        for (const node of topologicalSort(route)) {
          const runner = runners.get(node.type);
          if (!runner) {
            nodeResults[node.id] = {
              nodeId: node.id,
              type: node.type,
              status: "failed",
              error: `No runner registered for node type "${node.type}" (${node.id})`,
              logs: [`No runner registered for node type "${node.type}" (${node.id})`],
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            };
            throw new Error(`No runner registered for node type "${node.type}" (${node.id})`);
          }

          const nodeStartedAt = new Date().toISOString();
          nodeResults[node.id] = {
            nodeId: node.id,
            type: node.type,
            status: "running",
            logs: [],
            startedAt: nodeStartedAt,
            completedAt: ""
          };
          log(`Starting ${node.id}`, node.id);
          try {
            const params = resolveTemplates(node.params ?? {}, nodeOutputs) as Record<string, unknown>;
            const inputs = collectInputs(route, node, nodeOutputs);
            const result = await runner({ node, params, inputs, context });
            const output = result.output ?? {};
            nodeOutputs[node.id] = output;
            nodeResults[node.id] = {
              nodeId: node.id,
              type: node.type,
              status: "succeeded",
              output,
              logs: result.logs ?? [],
              metrics: result.metrics,
              provenance: result.provenance,
              startedAt: nodeStartedAt,
              completedAt: new Date().toISOString()
            };
            for (const entry of result.logs ?? []) log(entry, node.id);
            log(`Completed ${node.id}`, node.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            nodeResults[node.id] = {
              nodeId: node.id,
              type: node.type,
              status: "failed",
              error: message,
              logs: [message],
              startedAt: nodeStartedAt,
              completedAt: new Date().toISOString()
            };
            throw error;
          }
        }

        const completed = completeRun(runId, "succeeded", startedAt, nodeResults, logs, route, outputDirectory);
        await persistRunResult(completed);
        return completed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(message);
        const completed = completeRun(runId, "failed", startedAt, nodeResults, logs, route, outputDirectory);
        await persistRunResult(completed);
        return completed;
      }
    }
  };
}

function completeRun(
  runId: string,
  status: RunStatus,
  startedAt: string,
  nodeResults: Record<string, NodeResult>,
  logs: RunLogEntry[],
  route: OpenRoute,
  outputDirectory: string
): RunResult {
  return {
    runId,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    nodeResults,
    logs,
    provenance: {
      routeId: route.route.id,
      routeVersion: route.routeVersion,
      tool: "snarkroute",
      sourceProvenance: route.provenance ?? {}
    },
    outputDirectory
  };
}

async function persistRunResult(result: RunResult): Promise<void> {
  await writeFile(join(result.outputDirectory, "run.json"), JSON.stringify(result, null, 2), "utf8");
}

export function topologicalSort(route: OpenRoute): RouteNode[] {
  const nodesById = new Map(route.nodes.map((node) => [node.id, node]));
  const incoming = new Map(route.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const edge of route.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const queue = route.nodes.filter((node) => incoming.get(node.id) === 0);
  const sorted: RouteNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      incoming.set(target, (incoming.get(target) ?? 0) - 1);
      if (incoming.get(target) === 0) {
        const targetNode = nodesById.get(target);
        if (targetNode) queue.push(targetNode);
      }
    }
  }

  if (sorted.length !== route.nodes.length) {
    throw new Error(`Route contains a cycle: ${detectCycles(route).join(" -> ")}`);
  }

  return sorted;
}

export function detectCycles(route: OpenRoute): string[] {
  const graph = new Map<string, string[]>();
  for (const node of route.nodes) graph.set(node.id, []);
  for (const edge of route.edges) graph.get(edge.from)?.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (nodeId: string): string[] => {
    if (visiting.has(nodeId)) {
      return [...stack.slice(stack.indexOf(nodeId)), nodeId];
    }
    if (visited.has(nodeId)) return [];
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const next of graph.get(nodeId) ?? []) {
      const cycle = visit(next);
      if (cycle.length > 0) return cycle;
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
    return [];
  };

  for (const node of route.nodes) {
    const cycle = visit(node.id);
    if (cycle.length > 0) return cycle;
  }
  return [];
}

export function resolveTemplates(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_REF_PATTERN, (match, nodeId: string, path: string) => {
      if (!(nodeId in context)) {
        throw new Error(`Template reference "${match}" points to missing or not-yet-executed node "${nodeId}". Add an edge from "${nodeId}" to this node.`);
      }
      const resolved = readPath(context[nodeId], path);
      if (resolved === undefined) {
        throw new Error(`Template reference "${match}" points to missing output field "${path}" on node "${nodeId}".`);
      }
      return resolved === null ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, context)]));
  }
  return value;
}

export interface TemplateReference {
  nodeId: string;
  path: string;
  raw: string;
}

const TEMPLATE_REF_PATTERN = /\{\{\s*([A-Za-z0-9_-]+)\.output\.([A-Za-z0-9_.-]+)\s*\}\}/g;
const ANY_TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function extractTemplateReferences(value: unknown): TemplateReference[] {
  const refs: TemplateReference[] = [];
  collectTemplateReferences(value, refs);
  return refs;
}

export function validateTemplateDependencies(route: OpenRoute): void {
  const nodeIds = new Set(route.nodes.map((node) => node.id));
  const edgeKeys = new Set(route.edges.map((edge) => `${edge.from}->${edge.to}`));

  for (const node of route.nodes) {
    for (const ref of extractTemplateReferences(node.params ?? {})) {
      if (!nodeIds.has(ref.nodeId)) {
        throw new Error(`Node "${node.id}" has template reference "${ref.raw}" to missing node "${ref.nodeId}".`);
      }
      if (!edgeKeys.has(`${ref.nodeId}->${node.id}`)) {
        throw new Error(`Node "${node.id}" references "${ref.nodeId}" in params but has no edge from "${ref.nodeId}" to "${node.id}". Edges define execution dependencies; template references define value binding.`);
      }
    }
  }
}

function collectTemplateReferences(value: unknown, refs: TemplateReference[]): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(ANY_TEMPLATE_PATTERN)) {
      const raw = match[0];
      const parsed = /^\s*([A-Za-z0-9_-]+)\.output\.([A-Za-z0-9_.-]+)\s*$/.exec(match[1]);
      if (!parsed) {
        throw new Error(`Invalid template reference "${raw}". Expected {{nodeId.output.field}}.`);
      }
      refs.push({ nodeId: parsed[1], path: parsed[2], raw });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTemplateReferences(item, refs);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectTemplateReferences(item, refs);
  }
}

function collectInputs(route: OpenRoute, node: RouteNode, nodeOutputs: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const edge of route.edges.filter((candidate) => candidate.to === node.id)) {
    inputs[edge.from] = nodeOutputs[edge.from];
  }
  return inputs;
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}
