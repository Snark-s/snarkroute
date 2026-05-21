import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OpenRoute, RouteEdge, RouteNode } from "@snarkroute/protocol";

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
  providerUsage?: ProviderUsageEvent | ProviderUsageEvent[];
  internalNodeResults?: Record<string, NodeResult>;
  internalLogs?: RunLogEntry[];
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
  economics: RunEconomicsSummary;
  outputDirectory: string;
}

export interface ExecuteOptions {
  runId?: string;
  outputDirectory?: string;
  activeProfile?: string;
  ledgerPath?: string;
  initialNodeOutputs?: Record<string, unknown>;
  onNodeResult?: (result: NodeResult) => void;
}

export interface ProviderUsageEvent {
  provider: string;
  model?: string;
  providerModel?: string;
  logicalModel?: string;
  nodeId?: string;
  nodeType?: string;
  externalId?: string;
  status?: string;
  metrics?: Record<string, unknown>;
  estimatedCost?: number | null;
  actualCost?: number | null;
  actualCostCurrency?: string | null;
  pricingHint?: string;
  pricingSource?: string;
  pricingQuote?: unknown;
}

export interface RunEconomicsSummary {
  mode: "metadata-only" | "accounting-only" | "disabled";
  paymentExecuted: false;
  activeProfile?: string;
  routeId?: string;
  routeTitle?: string;
  routeAuthor?: unknown;
  contributors?: unknown[];
  revenueSplits?: unknown[];
  providersUsed: ProviderUsageEvent[];
  costSummary: {
    currency?: string;
    estimatedProviderCost: number | null;
    actualProviderCost: number | null;
    notes?: string;
  };
  warnings: string[];
}

export interface RunLedgerEntry {
  runId: string;
  createdAt: string;
  completedAt: string;
  status: RunStatus;
  routeId?: string;
  routeTitle?: string;
  activeProfile?: string;
  providersUsed: ProviderUsageEvent[];
  estimatedProviderCost: number | null;
  actualProviderCost: number | null;
  paymentExecuted: false;
}

export interface RouteExecutor {
  registerNodeRunner: (type: string, runner: NodeRunner) => void;
  registerCapabilityProvider: (capability: string, providerType: string, options?: CapabilityProviderOptions) => void;
  executeRoute: (route: OpenRoute, options?: ExecuteOptions) => Promise<RunResult>;
}

export interface CapabilityProviderOptions {
  defaultParams?: Record<string, unknown>;
  priority?: number;
}

interface CapabilityProviderRegistration {
  capability: string;
  providerType: string;
  defaultParams: Record<string, unknown>;
  priority: number;
}

export function createExecutor(): RouteExecutor {
  const runners = new Map<string, NodeRunner>();
  const capabilityProviders = new Map<string, CapabilityProviderRegistration[]>();
  runners.set("compound.subroute", createCompoundRunner(() => executor));

  const executor: RouteExecutor = {
    registerNodeRunner(type, runner) {
      runners.set(type, runner);
    },

    registerCapabilityProvider(capability, providerType, options = {}) {
      const providers = capabilityProviders.get(capability) ?? [];
      providers.push({
        capability,
        providerType,
        defaultParams: options.defaultParams ?? {},
        priority: options.priority ?? 0
      });
      providers.sort((left, right) => right.priority - left.priority || left.providerType.localeCompare(right.providerType));
      capabilityProviders.set(capability, providers);
    },

    async executeRoute(route, options = {}) {
      const runId = options.runId ?? `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const outputDirectory = options.outputDirectory ?? join(process.cwd(), "data", "runs", runId);
      await mkdir(outputDirectory, { recursive: true });

      const startedAt = new Date().toISOString();
      const logs: RunLogEntry[] = [];
      const providersUsed: ProviderUsageEvent[] = [];
      const routeNodes = route.nodes as RouteNode[];
      const nodeResults: Record<string, NodeResult> = Object.fromEntries(
        routeNodes.map((node: RouteNode) => [
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
      const nodeOutputs: Record<string, unknown> = { ...(options.initialNodeOutputs ?? {}) };
      const log = (message: string, nodeId?: string) => logs.push({ timestamp: new Date().toISOString(), message, nodeId });

      const context: NodeExecutionContext = { runId, route, outputDirectory, nodeOutputs, log };

      try {
        const cycle = detectCycles(route);
        if (cycle.length > 0) {
          throw new Error(`Route contains a cycle: ${cycle.join(" -> ")}`);
        }
        validateTemplateDependencies(route);

        for (const node of topologicalSort(route)) {
          if (Object.prototype.hasOwnProperty.call(options.initialNodeOutputs ?? {}, node.id)) {
            const now = new Date().toISOString();
            nodeResults[node.id] = {
              nodeId: node.id,
              type: node.type,
              status: "succeeded",
              output: nodeOutputs[node.id],
              logs: ["Using existing output"],
              startedAt: now,
              completedAt: now
            };
            options.onNodeResult?.(nodeResults[node.id]);
            log(`Using existing output for ${node.id}`, node.id);
            continue;
          }

          const runner = runners.get(node.type) ?? getCapabilityRunner(node, runners, capabilityProviders);
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
            options.onNodeResult?.(nodeResults[node.id]);
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
          options.onNodeResult?.(nodeResults[node.id]);
          log(`Starting ${node.id}`, node.id);
          try {
            const params = resolveTemplates(node.params ?? {}, nodeOutputs) as Record<string, unknown>;
            const inputs = collectInputs(route, node, nodeOutputs);
            const result = await runner({ node, params, inputs, context });
            const output = result.output ?? {};
            providersUsed.push(...normalizeProviderUsage(result.providerUsage, node));
            nodeOutputs[node.id] = output;
            for (const [internalNodeId, internalResult] of Object.entries(result.internalNodeResults ?? {})) {
              nodeResults[`${node.id}/${internalNodeId}`] = {
                ...internalResult,
                nodeId: `${node.id}/${internalNodeId}`,
                type: internalResult.type
              };
              options.onNodeResult?.(nodeResults[`${node.id}/${internalNodeId}`]);
            }
            for (const entry of result.internalLogs ?? []) {
              logs.push({ ...entry, nodeId: entry.nodeId ? `${node.id}/${entry.nodeId}` : node.id });
            }
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
            options.onNodeResult?.(nodeResults[node.id]);
            for (const entry of result.logs ?? []) log(entry, node.id);
            log(`Completed ${node.id}`, node.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof CompoundExecutionError) {
              providersUsed.push(...error.providersUsed);
              for (const [internalNodeId, internalResult] of Object.entries(error.internalNodeResults)) {
                nodeResults[`${node.id}/${internalNodeId}`] = {
                  ...internalResult,
                  nodeId: `${node.id}/${internalNodeId}`,
                  type: internalResult.type
                };
                options.onNodeResult?.(nodeResults[`${node.id}/${internalNodeId}`]);
              }
              for (const entry of error.internalLogs) {
                logs.push({ ...entry, nodeId: entry.nodeId ? `${node.id}/${entry.nodeId}` : node.id });
              }
            }
            nodeResults[node.id] = {
              nodeId: node.id,
              type: node.type,
              status: "failed",
              error: message,
              logs: [message],
              startedAt: nodeStartedAt,
              completedAt: new Date().toISOString()
            };
            options.onNodeResult?.(nodeResults[node.id]);
            throw error;
          }
        }

        const completed = completeRun(runId, "succeeded", startedAt, nodeResults, logs, route, outputDirectory, providersUsed, options.activeProfile);
        await appendRunLedger(completed, options.ledgerPath);
        await persistRunResult(completed);
        return completed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(message);
        const completed = completeRun(runId, "failed", startedAt, nodeResults, logs, route, outputDirectory, providersUsed, options.activeProfile);
        await appendRunLedger(completed, options.ledgerPath);
        await persistRunResult(completed);
        return completed;
      }
    }
  };
  return executor;
}

class CompoundExecutionError extends Error {
  constructor(
    message: string,
    readonly internalNodeResults: Record<string, NodeResult>,
    readonly internalLogs: RunLogEntry[],
    readonly providersUsed: ProviderUsageEvent[]
  ) {
    super(message);
    this.name = "CompoundExecutionError";
  }
}

function createCompoundRunner(getExecutor: () => RouteExecutor): NodeRunner {
  return async ({ node, inputs, context }) => {
    const compoundNode = node as RouteNode & {
      compound?: {
        title?: string;
        inputs?: Array<{ id: string; nodeId: string; port?: string; targets?: Array<{ nodeId: string; port?: string }> }>;
        outputs?: Array<{ id: string; nodeId: string; port?: string }>;
      };
      subroute?: OpenRoute;
    };
    if (!compoundNode.subroute) throw new Error(`Compound node "${node.id}" has no subroute.`);
    const interfaceInputs: Array<{ id: string; nodeId: string; port?: string; targets?: Array<{ nodeId: string; port?: string }> }> = compoundNode.compound?.inputs ?? [];
    const interfaceOutputs: Array<{ id: string; nodeId: string; port?: string }> = compoundNode.compound?.outputs ?? [];
    const syntheticNodes: RouteNode[] = [];
    const syntheticEdges: RouteEdge[] = [];
    const initialNodeOutputs: Record<string, unknown> = {};

    for (const port of interfaceInputs) {
      const syntheticId = `${node.id}__input__${port.id}`;
      syntheticNodes.push({ id: syntheticId, type: "compound.input" });
      const targets = port.targets && port.targets.length > 0 ? port.targets : [{ nodeId: port.nodeId, port: port.port }];
      for (const target of targets) {
        syntheticEdges.push({ from: syntheticId, to: target.nodeId, fromPort: "value", toPort: target.port ?? port.id });
      }
      initialNodeOutputs[syntheticId] = { value: inputs[port.id] };
    }

    const subroute: OpenRoute = {
      ...compoundNode.subroute,
      route: {
        ...compoundNode.subroute.route,
        id: `${context.route.route.id}.${node.id}`,
        title: compoundNode.compound?.title ?? node.title ?? compoundNode.subroute.route.title
      },
      nodes: [...syntheticNodes, ...compoundNode.subroute.nodes],
      edges: [...syntheticEdges, ...compoundNode.subroute.edges]
    };
    const result = await getExecutor().executeRoute(subroute, {
      runId: `${context.runId}_${node.id}`,
      outputDirectory: join(context.outputDirectory, node.id),
      initialNodeOutputs
    });

    const internalNodeResults = Object.fromEntries(
      Object.entries(result.nodeResults).filter(([internalNodeId]) => !internalNodeId.startsWith(`${node.id}__input__`))
    );
    const internalLogs = result.logs.filter((entry) => !entry.nodeId?.startsWith(`${node.id}__input__`));

    if (result.status !== "succeeded") {
      const failed = Object.values(internalNodeResults).find((entry) => entry.status === "failed");
      const failedId = failed?.nodeId ?? "unknown";
      throw new CompoundExecutionError(
        `Compound node "${node.id}" failed inside internal node "${failedId}": ${failed?.error ?? "subroute failed"}`,
        internalNodeResults,
        internalLogs,
        result.economics.providersUsed
      );
    }

    const output = Object.fromEntries(
      interfaceOutputs.map((port) => [port.id, readOutputPort(result.nodeResults[port.nodeId]?.output, port.port ?? port.id)])
    );
    return {
      output,
      logs: [`Subroute completed with ${Object.keys(internalNodeResults).length} internal node(s).`],
      providerUsage: result.economics.providersUsed,
      provenance: { subrouteRunId: result.runId, internalNodeIds: Object.keys(internalNodeResults) },
      internalNodeResults,
      internalLogs
    };
  };
}

function getCapabilityRunner(
  node: RouteNode,
  runners: Map<string, NodeRunner>,
  capabilityProviders: Map<string, CapabilityProviderRegistration[]>
): NodeRunner | undefined {
  const capability = readCapabilityId(node);
  if (!capability) return undefined;
  const providers = capabilityProviders.get(capability) ?? [];
  if (providers.length === 0) return undefined;
  return createCapabilityRunner(capability, providers, runners);
}

function createCapabilityRunner(
  capability: string,
  providers: CapabilityProviderRegistration[],
  runners: Map<string, NodeRunner>
): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const selected = selectCapabilityProvider(capability, params, node, providers);
    const providerRunner = runners.get(selected.providerType);
    if (!providerRunner) throw new Error(`Capability "${capability}" selected provider "${selected.providerType}", but no runner is registered for that provider.`);

    const providerNode: RouteNode = {
      id: `${node.id}__provider`,
      type: selected.providerType,
      title: node.title ? `${node.title} Provider` : undefined,
      params: mergeProviderParams(selected.defaultParams, params)
    };
    const providerContext: NodeExecutionContext = {
      ...context,
      log: (message, nodeId) => context.log(message, nodeId ?? providerNode.id)
    };
    const startedAt = new Date().toISOString();
    const result = await providerRunner({
      node: providerNode,
      params: providerNode.params ?? {},
      inputs,
      context: providerContext
    });
    const completedAt = new Date().toISOString();
    return {
      output: result.output ?? {},
      logs: [`Capability "${capability}" used provider "${selected.providerType}".`, ...(result.logs ?? [])],
      metrics: result.metrics,
      provenance: {
        ...(result.provenance ?? {}),
        capability,
        selectedProvider: selected.providerType,
        resources: readResourceRefs(node, params)
      },
      providerUsage: result.providerUsage,
      internalNodeResults: {
        [providerNode.id]: {
          nodeId: providerNode.id,
          type: providerNode.type,
          status: "succeeded",
          output: result.output ?? {},
          logs: result.logs ?? [],
          metrics: result.metrics,
          provenance: result.provenance,
          startedAt,
          completedAt
        }
      }
    };
  };
}

function readCapabilityId(node: RouteNode): string | null {
  const capability = (node as RouteNode & { capability?: { id?: unknown } }).capability?.id;
  if (typeof capability === "string" && capability.trim()) return capability.trim();
  return node.type.startsWith("capability.") ? node.type.slice("capability.".length) : null;
}

function selectCapabilityProvider(
  capability: string,
  params: Record<string, unknown>,
  node: RouteNode,
  providers: CapabilityProviderRegistration[]
): CapabilityProviderRegistration {
  const requested = stringParam(params.provider ?? params.providerType ?? params.nodeType ?? (node as RouteNode & { capability?: { provider?: unknown } }).capability?.provider);
  if (!requested) return providers[0];
  const provider = providers.find((candidate) => candidate.providerType === requested);
  if (!provider) {
    throw new Error(`Capability "${capability}" requested provider "${requested}", but it does not declare support for that capability.`);
  }
  return provider;
}

function mergeProviderParams(defaultParams: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const providerParams = params.providerParams && typeof params.providerParams === "object" && !Array.isArray(params.providerParams)
    ? params.providerParams as Record<string, unknown>
    : {};
  const passThrough = Object.fromEntries(
    Object.entries(params).filter(([key]) => !["provider", "providerType", "nodeType", "providerParams"].includes(key))
  );
  return { ...defaultParams, ...passThrough, ...providerParams };
}

function readResourceRefs(node: RouteNode, params: Record<string, unknown>): string[] {
  const capabilityResources = (node as RouteNode & { capability?: { resources?: unknown } }).capability?.resources;
  const paramsResources = params.resources;
  const values = Array.isArray(paramsResources) ? paramsResources : Array.isArray(capabilityResources) ? capabilityResources : [];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function completeRun(
  runId: string,
  status: RunStatus,
  startedAt: string,
  nodeResults: Record<string, NodeResult>,
  logs: RunLogEntry[],
  route: OpenRoute,
  outputDirectory: string,
  providersUsed: ProviderUsageEvent[],
  activeProfile?: string
): RunResult {
  const completedAt = new Date().toISOString();
  const economics = buildRunEconomics(route, providersUsed, activeProfile);
  return {
    runId,
    status,
    startedAt,
    completedAt,
    nodeResults,
    logs,
    provenance: {
      routeId: route.route.id,
      routeVersion: route.routeVersion,
      tool: "snarkroute",
      sourceProvenance: route.provenance ?? {}
    },
    economics,
    outputDirectory
  };
}

async function persistRunResult(result: RunResult): Promise<void> {
  await writeFile(join(result.outputDirectory, "run.json"), JSON.stringify(result, null, 2), "utf8");
}

async function appendRunLedger(result: RunResult, ledgerPath = join(process.cwd(), "data", "ledger", "runs.jsonl")): Promise<void> {
  try {
    await mkdir(dirname(ledgerPath), { recursive: true });
    const entry: RunLedgerEntry = {
      runId: result.runId,
      createdAt: result.startedAt,
      completedAt: result.completedAt,
      status: result.status,
      routeId: result.economics.routeId,
      routeTitle: result.economics.routeTitle,
      activeProfile: result.economics.activeProfile,
      providersUsed: result.economics.providersUsed.map(stripProviderUsageSecrets),
      estimatedProviderCost: result.economics.costSummary.estimatedProviderCost,
      actualProviderCost: result.economics.costSummary.actualProviderCost,
      paymentExecuted: false
    };
    await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.economics.warnings.push(`Could not append local ledger entry: ${message}`);
  }
}

function buildRunEconomics(route: OpenRoute, providersUsed: ProviderUsageEvent[], activeProfile?: string): RunEconomicsSummary {
  const routeEconomics = route.economics;
  const mode = routeEconomics?.enabled === false ? "disabled" : routeEconomics?.mode ?? (routeEconomics ? "metadata-only" : "disabled");
  const sanitizedProviders = providersUsed.map(stripProviderUsageSecrets);
  const estimatedCosts = collectCosts(sanitizedProviders, "estimatedCost");
  const actualCosts = collectCosts(sanitizedProviders, "actualCost");
  return {
    mode,
    paymentExecuted: false,
    activeProfile,
    routeId: route.route.id,
    routeTitle: route.route.title,
    routeAuthor: routeEconomics?.author ?? route.route.author,
    contributors: routeEconomics?.contributors,
    revenueSplits: routeEconomics?.revenueSplits,
    providersUsed: sanitizedProviders,
    costSummary: {
      currency: routeEconomics?.currency,
      estimatedProviderCost: estimatedCosts.length > 0 ? sum(estimatedCosts) : null,
      actualProviderCost: actualCosts.length > 0 ? sum(actualCosts) : null,
      notes: routeEconomics?.providerCosts?.length ? "Route provider cost metadata is preserved; no billing calls were made." : "No payment executed. Provider actual cost may be unknown."
    },
    warnings: []
  };
}

function normalizeProviderUsage(providerUsage: NodeRunnerResult["providerUsage"], node: RouteNode): ProviderUsageEvent[] {
  const events = Array.isArray(providerUsage) ? providerUsage : providerUsage ? [providerUsage] : [];
  return events.map((event) => ({
    ...event,
    nodeId: event.nodeId ?? node.id,
    nodeType: event.nodeType ?? node.type
  }));
}

function stripProviderUsageSecrets(event: ProviderUsageEvent): ProviderUsageEvent {
  return {
    provider: event.provider,
    model: event.model,
    providerModel: event.providerModel,
    logicalModel: event.logicalModel,
    nodeId: event.nodeId,
    nodeType: event.nodeType,
    externalId: event.externalId,
    status: event.status,
    metrics: event.metrics,
    estimatedCost: event.estimatedCost ?? null,
    actualCost: event.actualCost ?? null,
    actualCostCurrency: event.actualCostCurrency ?? null,
    pricingHint: event.pricingHint,
    pricingSource: event.pricingSource,
    pricingQuote: event.pricingQuote
  };
}

function collectCosts(events: ProviderUsageEvent[], key: "estimatedCost" | "actualCost"): number[] {
  return events.map((event) => event[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function sum(values: number[]): number {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(6));
}

export function topologicalSort(route: OpenRoute): RouteNode[] {
  const routeNodes = route.nodes as RouteNode[];
  const routeEdges = route.edges as RouteEdge[];
  const nodesById = new Map(routeNodes.map((node: RouteNode) => [node.id, node]));
  const incoming = new Map(routeNodes.map((node: RouteNode) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const edge of routeEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const queue = routeNodes.filter((node: RouteNode) => incoming.get(node.id) === 0);
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

  if (sorted.length !== routeNodes.length) {
    throw new Error(`Route contains a cycle: ${detectCycles(route).join(" -> ")}`);
  }

  return sorted;
}

export function detectCycles(route: OpenRoute): string[] {
  const routeNodes = route.nodes as RouteNode[];
  const routeEdges = route.edges as RouteEdge[];
  const graph = new Map<string, string[]>();
  for (const node of routeNodes) graph.set(node.id, []);
  for (const edge of routeEdges) graph.get(edge.from)?.push(edge.to);

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

  for (const node of routeNodes) {
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
  const routeNodes = route.nodes as RouteNode[];
  const routeEdges = route.edges as RouteEdge[];
  const nodeIds = new Set(routeNodes.map((node: RouteNode) => node.id));
  const edgeKeys = new Set(routeEdges.map((edge: RouteEdge) => `${edge.from}->${edge.to}`));

  for (const node of routeNodes) {
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
  for (const edge of (route.edges as RouteEdge[]).filter((candidate: RouteEdge) => candidate.to === node.id)) {
    const value = readOutputPort(nodeOutputs[edge.from], edge.fromPort);
    const key = edge.toPort ?? edge.from;
    if (key in inputs) {
      inputs[key] = Array.isArray(inputs[key]) ? [...inputs[key], value] : [inputs[key], value];
    } else {
      inputs[key] = value;
    }
  }
  return inputs;
}

function readOutputPort(output: unknown, port?: string): unknown {
  if (!port || port === "output") return output;
  if (output && typeof output === "object" && port in output) {
    return (output as Record<string, unknown>)[port];
  }
  if (port === "image" || port === "file" || port === "video") {
    return output;
  }
  return readPath(output, port);
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}
