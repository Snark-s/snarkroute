import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OpenRoute, RouteEdge, RouteNode } from "@snarkroute/protocol";

export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

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

export interface CostEstimate {
  nodeId: string;
  nodeType: string;
  estimatedCredits: number;
  estimatedProviderCostAmount: number | null;
  providerCostCurrency: string | null;
  usageUnits: ActualUsage;
  provider?: string;
  model?: string;
  operation?: string;
  free?: boolean;
  baseCostMicrousd?: number;
  baseCredits?: number;
  globalMarkupPercent?: number;
  globalMarkupCredits?: number;
  nodeMarkupPercent?: number;
  nodeMarkupCredits?: number;
  markupCredits?: number;
  finalCredits?: number;
  maxChargeCredits?: number;
  pricingSource?: PricingSource;
  pricingConfidence?: PricingConfidence;
  pricingSnapshotId?: string;
  canonicalModelId?: string;
  providerNativeModelId?: string;
  fetchedAt?: string;
  staleAfter?: string;
  fallback?: boolean;
  pricingBreakdown?: PricingBreakdown;
  usageSource: "provider" | "estimated" | "unknown" | "catalog_estimate";
}

export type PricingSource = "provider_actual" | "pricing_catalog" | "fallback_estimate";
export type PricingConfidence = "high" | "medium" | "low";

export interface PricingBreakdown {
  nodeId: string;
  title?: string;
  nodeType: string;
  provider?: string;
  operation: string;
  model?: string;
  free: boolean;
  providerCostMicrousd: number;
  baseCostMicrousd: number;
  baseCredits: number;
  globalMarkupPercent: number;
  globalMarkupCredits: number;
  nodeMarkupPercent: number;
  nodeMarkupCredits: number;
  markupCredits: number;
  finalCredits: number;
  maxChargeCredits: number;
  pricingSource: PricingSource;
  pricingConfidence: PricingConfidence;
  pricingSnapshotId?: string;
  parameterRules?: Record<string, unknown>;
  canonicalModelId?: string;
  providerNativeModelId?: string;
  fetchedAt?: string;
  staleAfter?: string;
  fallback?: boolean;
  source: string;
  notes?: string;
}

export interface ActualUsage {
  inputTokens?: number;
  outputTokens?: number;
  imageCount?: number;
  videoSeconds?: number;
  requestCount?: number;
}

export interface NodeCostModel {
  estimateNode: (node: RouteNode) => CostEstimate;
  actualNode?: (node: RouteNode, result: NodeRunnerResult, providerUsage: ProviderUsageEvent[]) => Partial<CostEstimate> & { actualCredits?: number; actualProviderCostAmount?: number | null; actualProviderCostCurrency?: string | null; usageUnits?: ActualUsage };
}

export interface RunCostSummary {
  estimates: CostEstimate[];
  actuals: Array<CostEstimate & { actualCredits: number; actualProviderCostAmount: number | null; actualProviderCostCurrency?: string | null }>;
  totalEstimatedCredits: number;
  totalActualCredits: number;
  refundedCredits: number;
  reservedCredits?: number;
  balanceAfter?: number | null;
}

export interface NodeResult {
  nodeId: string;
  type: string;
  status: RunStatus;
  output?: unknown;
  error?: string;
  logs: string[];
  metrics?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  costEstimate?: CostEstimate;
  actualUsage?: ActualUsage;
  actualCredits?: number;
  actualProviderCostAmount?: number | null;
  actualProviderCostCurrency?: string | null;
  usageSource?: "provider" | "estimated" | "unknown" | "catalog_estimate";
  providerUsage?: ProviderUsageEvent[];
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
  costSummary: RunCostSummary;
  outputDirectory: string;
}

export interface ExecuteOptions {
  runId?: string;
  outputDirectory?: string;
  activeProfile?: string;
  ledgerPath?: string;
  initialNodeOutputs?: Record<string, unknown>;
  onNodeResult?: (result: NodeResult) => void;
  costModel?: NodeCostModel;
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
  providerCostMicrousd?: number | null;
  baseCredits?: number | null;
  markupCredits?: number | null;
  finalCredits?: number | null;
  pricingConfidence?: PricingConfidence;
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
      const costModel = options.costModel ?? DEFAULT_NODE_COST_MODEL;
      const costEstimates = estimateRouteCost(route, costModel);
      const nodeResults: Record<string, NodeResult> = Object.fromEntries(
        routeNodes.map((node: RouteNode) => {
          const estimate = costEstimates.estimates.find((entry) => entry.nodeId === node.id);
          return [
            node.id,
            {
            nodeId: node.id,
            type: node.type,
            status: "pending" as RunStatus,
            logs: [],
            costEstimate: estimate,
            startedAt: "",
            completedAt: ""
          }
          ];
        })
      );
      const nodeOutputs: Record<string, unknown> = { ...(options.initialNodeOutputs ?? {}) };
      const log = (message: string, nodeId?: string) => logs.push({ timestamp: new Date().toISOString(), message: redactSecrets(message), nodeId });
      const nodesById = new Map(routeNodes.map((routeNode) => [routeNode.id, routeNode]));

      const context: NodeExecutionContext = { runId, route, outputDirectory, nodeOutputs, log };

      try {
        const cycle = detectCycles(route);
        if (cycle.length > 0) {
          throw new Error(`Route contains a cycle: ${cycle.join(" -> ")}`);
        }
        validateTemplateDependencies(route);

        for (const node of topologicalSort(route)) {
          const blockedBy = upstreamBlockingNode(route, node, nodeResults, nodesById);
          if (blockedBy) {
            const now = new Date().toISOString();
            const label = blockedBy.title ?? blockedBy.id;
            const message = node.type.startsWith("preview.")
              ? `Skipped because upstream node failed: ${label}`
              : `Skipped because upstream node did not complete: ${label}`;
            nodeResults[node.id] = {
              nodeId: node.id,
              type: node.type,
              status: "skipped",
              error: message,
              logs: [message],
              costEstimate: nodeResults[node.id]?.costEstimate,
              actualUsage: { requestCount: 0 },
              actualCredits: 0,
              actualProviderCostAmount: 0,
              actualProviderCostCurrency: null,
              usageSource: "estimated",
              startedAt: now,
              completedAt: now
            };
            options.onNodeResult?.(nodeResults[node.id]);
            log(message, node.id);
            continue;
          }

          if (Object.prototype.hasOwnProperty.call(options.initialNodeOutputs ?? {}, node.id)) {
            const now = new Date().toISOString();
            nodeResults[node.id] = {
              nodeId: node.id,
              type: node.type,
              status: "succeeded",
              output: nodeOutputs[node.id],
              logs: ["Using existing output"],
              costEstimate: nodeResults[node.id]?.costEstimate,
              actualUsage: { requestCount: 0 },
              actualCredits: 0,
              actualProviderCostAmount: 0,
              actualProviderCostCurrency: null,
              usageSource: "estimated",
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
              error: redactSecrets(`No runner registered for node type "${node.type}" (${node.id})`),
              logs: [redactSecrets(`No runner registered for node type "${node.type}" (${node.id})`)],
              costEstimate: nodeResults[node.id]?.costEstimate,
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
            costEstimate: nodeResults[node.id]?.costEstimate,
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
            const nodeProviderUsage = normalizeProviderUsage(result.providerUsage, node);
            providersUsed.push(...nodeProviderUsage);
            const nonBillableFailure = nonBillableProviderFailure(node, output, nodeProviderUsage, nodeResults[node.id]?.costEstimate);
            if (nonBillableFailure) {
              nodeResults[node.id] = {
                nodeId: node.id,
                type: node.type,
                status: "failed",
                error: nonBillableFailure,
                logs: [nonBillableFailure, ...(result.logs ?? []).map(redactSecrets)],
                metrics: result.metrics,
                provenance: result.provenance,
                costEstimate: nodeResults[node.id]?.costEstimate,
                actualUsage: { requestCount: nodeProviderUsage.length > 0 ? 1 : 0 },
                actualCredits: 0,
                actualProviderCostAmount: 0,
                actualProviderCostCurrency: null,
                usageSource: "provider",
                providerUsage: nodeProviderUsage.map((event) => ({ ...event, status: providerFailureStatus(event.status) ? event.status : "error" })),
                startedAt: nodeStartedAt,
                completedAt: new Date().toISOString()
              };
              options.onNodeResult?.(nodeResults[node.id]);
              log(nonBillableFailure, node.id);
              continue;
            }
            const actualCost = actualNodeCost(node, result, nodeProviderUsage, nodeResults[node.id]?.costEstimate, costModel);
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
              logs: (result.logs ?? []).map(redactSecrets),
              metrics: result.metrics,
              provenance: result.provenance,
              costEstimate: nodeResults[node.id]?.costEstimate,
              actualUsage: actualCost.usageUnits,
              actualCredits: actualCost.actualCredits,
              actualProviderCostAmount: actualCost.actualProviderCostAmount,
              actualProviderCostCurrency: actualCost.actualProviderCostCurrency,
              usageSource: actualCost.usageSource,
              providerUsage: nodeProviderUsage,
              startedAt: nodeStartedAt,
              completedAt: new Date().toISOString()
            };
            options.onNodeResult?.(nodeResults[node.id]);
            for (const entry of result.logs ?? []) log(entry, node.id);
            log(`Completed ${node.id}`, node.id);
          } catch (error) {
            const rawMessage = redactSecrets(error instanceof Error ? error.message : String(error));
            const estimate = nodeResults[node.id]?.costEstimate;
            const message = isPaidProviderEstimate(estimate, []) ? noChargeProviderMessage(rawMessage) : rawMessage;
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
              costEstimate: nodeResults[node.id]?.costEstimate,
              actualUsage: { requestCount: 0 },
              actualCredits: 0,
              actualProviderCostAmount: 0,
              actualProviderCostCurrency: null,
              usageSource: "provider",
              startedAt: nodeStartedAt,
              completedAt: new Date().toISOString()
            };
            options.onNodeResult?.(nodeResults[node.id]);
            continue;
          }
        }

        const status = Object.values(nodeResults).some((result) => result.status === "failed" || result.status === "skipped") ? "failed" : "succeeded";
        const completed = completeRun(runId, status, startedAt, nodeResults, logs, route, outputDirectory, providersUsed, options.activeProfile, costEstimates);
        await appendRunLedger(completed, options.ledgerPath);
        await persistRunResult(completed);
        return completed;
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        log(message);
        const completed = completeRun(runId, "failed", startedAt, nodeResults, logs, route, outputDirectory, providersUsed, options.activeProfile, costEstimates);
        await appendRunLedger(completed, options.ledgerPath);
        await persistRunResult(completed);
        return completed;
      }
    }
  };
  return executor;
}

function upstreamBlockingNode(route: OpenRoute, node: RouteNode, nodeResults: Record<string, NodeResult>, nodesById: Map<string, RouteNode>): RouteNode | null {
  for (const edge of (route.edges as RouteEdge[]).filter((candidate) => candidate.to === node.id)) {
    const upstream = nodeResults[edge.from];
    if (upstream?.status === "failed" || upstream?.status === "skipped") return nodesById.get(edge.from) ?? null;
  }
  return null;
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
  activeProfile: string | undefined,
  estimateSummary: RunCostSummary
): RunResult {
  const completedAt = new Date().toISOString();
  const economics = buildRunEconomics(route, providersUsed, activeProfile);
  const costSummary = finalizeRunCostSummary(estimateSummary, nodeResults);
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
    costSummary,
    outputDirectory
  };
}

export function estimateRouteCost(route: OpenRoute, costModel: NodeCostModel = DEFAULT_NODE_COST_MODEL): RunCostSummary {
  const estimates = (route.nodes as RouteNode[]).map((node) => costModel.estimateNode(node));
  return {
    estimates,
    actuals: [],
    totalEstimatedCredits: sum(estimates.map((entry) => entry.estimatedCredits)),
    totalActualCredits: 0,
    refundedCredits: 0
  };
}

export const DEFAULT_NODE_COST_MODEL: NodeCostModel = {
  estimateNode(node) {
    const kind = nodeCostKind(node.type);
    const provider = providerForPricing(node);
    const model = modelForPricing(node);
    const operation = operationFromNodeType(node.type, kind);
    const pricingBreakdown = priceNode({ node, nodeType: node.type, provider, model, operation, kind });
    return {
      nodeId: node.id,
      nodeType: node.type,
      estimatedCredits: pricingBreakdown.finalCredits,
      estimatedProviderCostAmount: null,
      providerCostCurrency: null,
      usageUnits: {
        requestCount: 1,
        imageCount: kind === "image" ? 1 : undefined,
        videoSeconds: kind === "video" ? 5 : undefined
      },
      provider,
      model,
      operation,
      free: pricingBreakdown.free,
      baseCostMicrousd: pricingBreakdown.baseCostMicrousd,
      baseCredits: pricingBreakdown.baseCredits,
      globalMarkupPercent: pricingBreakdown.globalMarkupPercent,
      globalMarkupCredits: pricingBreakdown.globalMarkupCredits,
      nodeMarkupPercent: pricingBreakdown.nodeMarkupPercent,
      nodeMarkupCredits: pricingBreakdown.nodeMarkupCredits,
      markupCredits: pricingBreakdown.markupCredits,
      finalCredits: pricingBreakdown.finalCredits,
      maxChargeCredits: pricingBreakdown.maxChargeCredits,
      pricingSource: pricingBreakdown.pricingSource,
      pricingConfidence: pricingBreakdown.pricingConfidence,
      pricingSnapshotId: pricingBreakdown.pricingSnapshotId,
      canonicalModelId: pricingBreakdown.canonicalModelId,
      providerNativeModelId: pricingBreakdown.providerNativeModelId,
      fetchedAt: pricingBreakdown.fetchedAt,
      staleAfter: pricingBreakdown.staleAfter,
      fallback: pricingBreakdown.fallback,
      pricingBreakdown,
      usageSource: pricingBreakdown.pricingSource === "pricing_catalog" ? "catalog_estimate" : "estimated"
    };
  }
};

export type ProviderPricingCatalogEntry = {
  provider: string;
  model?: string;
  operation: string;
  parameterRules?: Record<string, unknown>;
  baseCostMicrousd: number;
  currency: "USD";
  effectiveFrom: string;
  source: string;
  canonicalModelId?: string;
  providerModelId?: string;
  providerNativeModelId?: string;
  pricingSnapshotId?: string;
  fetchedAt?: string;
  staleAfter?: string;
  fallback?: boolean;
  notes?: string;
};

export type BillingPricingConfig = {
  globalMarkupPercent: number;
  globalMarkupCredits: number;
  roundingMode: "ceil";
  minChargeCredits: number;
  updatedAt?: string;
  updatedBy?: string;
};

export type BillingPricingOverride = {
  provider?: string;
  operation?: string;
  model?: string;
  nodeType?: string;
  markupPercent: number;
  markupCredits: number;
  enabled: boolean;
  reason?: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type RuntimeProviderPricingCatalogEntry = ProviderPricingCatalogEntry;

export const CREDIT_UNIT = { creditsPerUsd: 1000, microusdPerCredit: 1000 };

export const PROVIDER_PRICING_CATALOG: ProviderPricingCatalogEntry[] = [];

export function currentRuntimeProviderPricingCatalog(): RuntimeProviderPricingCatalogEntry[] {
  const raw = process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRuntimeProviderPricingEntry).filter((entry): entry is RuntimeProviderPricingCatalogEntry => Boolean(entry));
  } catch {
    return [];
  }
}

function actualNodeCost(node: RouteNode, result: NodeRunnerResult, providerUsage: ProviderUsageEvent[], estimate: CostEstimate | undefined, costModel: NodeCostModel) {
  const custom = costModel.actualNode?.(node, result, providerUsage);
  const usage = providerUsage[0];
  const metrics = result.metrics ?? usage?.metrics ?? {};
  const inputTokens = numberMetric(metrics, "inputTokens") ?? numberMetric(metrics, "input_tokens");
  const outputTokens = numberMetric(metrics, "outputTokens") ?? numberMetric(metrics, "output_tokens");
  const imageCount = numberMetric(metrics, "imageCount") ?? numberMetric(metrics, "image_count");
  const videoSeconds = numberMetric(metrics, "videoSeconds") ?? numberMetric(metrics, "video_seconds");
  const actualProviderCostAmount = custom?.actualProviderCostAmount ?? usage?.actualCost ?? usage?.estimatedCost ?? estimate?.estimatedProviderCostAmount ?? null;
  const actualProviderCostCurrency = usage?.actualCostCurrency ?? estimate?.providerCostCurrency ?? (actualProviderCostAmount === null ? null : "USD");
  const actualCostMicrousd = microusdFromProviderCost(actualProviderCostAmount, actualProviderCostCurrency);
  const actualPricing = actualCostMicrousd !== null && estimate?.pricingBreakdown
    ? applyPricingMarkup({
      ...estimate.pricingBreakdown,
      providerCostMicrousd: actualCostMicrousd,
      baseCostMicrousd: actualCostMicrousd,
      baseCredits: creditsFromMicrousd(actualCostMicrousd),
      pricingSource: "provider_actual",
      pricingConfidence: "high",
      source: "provider_actual"
    })
    : null;
  const calculatedActualCredits = actualPricing ? actualPricing.finalCredits : estimate?.estimatedCredits ?? 0;
  return {
    actualCredits: integerCredits(custom?.actualCredits ?? calculatedActualCredits),
    actualProviderCostAmount,
    actualProviderCostCurrency,
    usageUnits: custom?.usageUnits ?? {
      inputTokens,
      outputTokens,
      imageCount,
      videoSeconds,
      requestCount: 1
    },
    usageSource: custom?.usageSource ?? (usage?.actualCost != null ? "provider" : estimate ? "catalog_estimate" : "unknown")
  } satisfies { actualCredits: number; actualProviderCostAmount: number | null; actualProviderCostCurrency: string | null; usageUnits: ActualUsage; usageSource: "provider" | "estimated" | "unknown" | "catalog_estimate" };
}

function nonBillableProviderFailure(node: RouteNode, output: unknown, providerUsage: ProviderUsageEvent[], estimate: CostEstimate | undefined): string | null {
  if (!isPaidProviderEstimate(estimate, providerUsage)) return null;
  const paidEstimate = estimate as CostEstimate;
  const failedUsage = providerUsage.find((event) => providerFailureStatus(event.status));
  if (failedUsage) return noChargeProviderMessage(`${failedUsage.provider ?? paidEstimate.provider ?? providerFromNodeType(node.type) ?? "Provider"} call failed.`);
  if (hasBillableProviderCompletion(output, providerUsage)) return null;
  return noChargeProviderMessage(`${node.title ?? node.id} did not produce a billable result.`);
}

function isPaidProviderEstimate(estimate: CostEstimate | undefined, providerUsage: ProviderUsageEvent[]): boolean {
  return Boolean(estimate && estimate.estimatedCredits > 0 && (estimate.provider || providerUsage.some((event) => event.provider)));
}

function hasBillableProviderCompletion(output: unknown, providerUsage: ProviderUsageEvent[]): boolean {
  if (providerUsage.some((event) => providerSuccessStatus(event.status) || event.actualCost != null)) return true;
  return hasUsableArtifact(output);
}

function providerSuccessStatus(status: unknown): boolean {
  const text = String(status ?? "").trim();
  if (/^2\d\d$/.test(text)) return true;
  return /^(succeeded|success|completed|complete|billable|ok)$/i.test(text);
}

function providerFailureStatus(status: unknown): boolean {
  return /^(failed|failure|error|errored|cancelled|canceled|timeout|timed_out|unavailable|auth_error|quota_exceeded)$/i.test(String(status ?? ""));
}

function hasUsableArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasUsableArtifact);
  const record = value as Record<string, unknown>;
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
  const path = typeof record.path === "string" && record.path.trim().length > 0;
  const localPath = typeof record.localPath === "string" && record.localPath.trim().length > 0;
  const originalUrl = typeof record.originalUrl === "string" && record.originalUrl.trim().length > 0;
  if ((path || localPath || originalUrl) && /^(image|video|audio)\//i.test(mimeType)) return true;
  return Object.values(record).some(hasUsableArtifact);
}

function noChargeProviderMessage(detail: string): string {
  const trimmed = detail.trim() || "Provider did not return a usable result.";
  if (/No credits were charged\.$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/[.。]\s*$/, "")}. No credits were charged.`;
}

function finalizeRunCostSummary(estimateSummary: RunCostSummary, nodeResults: Record<string, NodeResult>): RunCostSummary {
  const actuals = Object.values(nodeResults)
    .filter((result) => result.actualCredits !== undefined || result.costEstimate)
    .map((result) => ({
      ...(result.costEstimate ?? {
        nodeId: result.nodeId,
        nodeType: result.type,
        estimatedCredits: 0,
        estimatedProviderCostAmount: null,
        providerCostCurrency: null,
        usageUnits: {},
        usageSource: "unknown" as const
      }),
      actualCredits: integerCredits(result.actualCredits ?? (result.status === "succeeded" ? result.costEstimate?.estimatedCredits ?? 0 : 0)),
      actualProviderCostAmount: result.actualProviderCostAmount ?? result.costEstimate?.estimatedProviderCostAmount ?? null,
      actualProviderCostCurrency: result.actualProviderCostCurrency ?? result.costEstimate?.providerCostCurrency ?? null,
      usageUnits: result.actualUsage ?? result.costEstimate?.usageUnits ?? {},
      usageSource: result.usageSource ?? result.costEstimate?.usageSource ?? "unknown"
    }));
  const totalActualCredits = sum(actuals.map((entry) => entry.actualCredits));
  return {
    ...estimateSummary,
    actuals,
    totalActualCredits,
    refundedCredits: Math.max(0, estimateSummary.totalEstimatedCredits - totalActualCredits)
  };
}

export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s,}]+/gi, "$1=[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-or-[A-Za-z0-9_-]{8,})\b/g, "[redacted]");
}

function nodeCostKind(type: string): "free" | "text" | "image" | "video" | "transform" {
  if (isFreeNodeType(type)) return "free";
  if (/video/i.test(type)) return "video";
  if (/image|upscale|stableDiffusion|replicate|gemini|seedance/i.test(type)) return "image";
  if (/transform|template|input|output|debug|preview/i.test(type)) return "transform";
  return "text";
}

function isFreeNodeType(type: string): boolean {
  return type.startsWith("input.")
    || type.startsWith("asset.")
    || type.startsWith("output.")
    || type.startsWith("preview.")
    || type.startsWith("debug.")
    || type.startsWith("utility.")
    || type.startsWith("library.")
    || type.startsWith("compound.")
    || type === "text.promptCompose"
    || type === "text.static";
}

export function currentBillingPricingConfig(): BillingPricingConfig {
  return {
    globalMarkupPercent: numberFromEnv("BOOJUM_GLOBAL_MARKUP_PERCENT", 0),
    globalMarkupCredits: integerCredits(numberFromEnv("BOOJUM_GLOBAL_MARKUP_CREDITS", 0)),
    roundingMode: "ceil",
    minChargeCredits: integerCredits(numberFromEnv("BOOJUM_MIN_CHARGE_CREDITS", 0)),
    updatedAt: process.env.BOOJUM_PRICING_UPDATED_AT,
    updatedBy: process.env.BOOJUM_PRICING_UPDATED_BY
  };
}

export function currentBillingPricingOverrides(): BillingPricingOverride[] {
  const raw = process.env.BOOJUM_PRICING_OVERRIDES_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizePricingOverride(entry)).filter((entry): entry is BillingPricingOverride => Boolean(entry));
  } catch {
    return [];
  }
}

export function pricingCatalogView(config = currentBillingPricingConfig(), overrides = currentBillingPricingOverrides()): PricingBreakdown[] {
  return mergedProviderPricingCatalog().map((entry) => {
    const override = matchingPricingOverride({ provider: entry.provider, operation: entry.operation, model: entry.model }, overrides);
    return applyPricingMarkup({
      nodeId: `${entry.provider}:${entry.operation}:${entry.model ?? "*"}`,
      nodeType: "",
      provider: entry.provider,
      operation: entry.operation,
      model: entry.model,
      free: false,
      providerCostMicrousd: entry.baseCostMicrousd,
      baseCostMicrousd: entry.baseCostMicrousd,
      baseCredits: creditsFromMicrousd(entry.baseCostMicrousd),
      globalMarkupPercent: config.globalMarkupPercent,
      globalMarkupCredits: config.globalMarkupCredits,
      nodeMarkupPercent: override?.markupPercent ?? 0,
      nodeMarkupCredits: override?.markupCredits ?? 0,
      markupCredits: 0,
      finalCredits: 0,
      maxChargeCredits: 0,
      pricingSource: "pricing_catalog",
      pricingConfidence: pricingConfidenceForCatalogSource(entry.source),
      pricingSnapshotId: entry.pricingSnapshotId ?? pricingCatalogKey(entry),
      parameterRules: entry.parameterRules,
      canonicalModelId: entry.canonicalModelId,
      providerNativeModelId: entry.providerNativeModelId,
      fetchedAt: entry.fetchedAt,
      staleAfter: entry.staleAfter,
      fallback: entry.fallback === true,
      source: entry.source,
      notes: entry.notes
    }, config);
  });
}

function priceNode(input: { node: RouteNode; nodeType: string; provider?: string; model?: string; operation: string; kind: "free" | "text" | "image" | "video" | "transform" }): PricingBreakdown {
  const config = currentBillingPricingConfig();
  if (input.kind === "free" || input.kind === "transform") {
    return freePricingBreakdown(input.node, input.nodeType, input.operation, input.provider, input.model);
  }
  const catalogMatch = findPricingCatalogEntry(input.provider, input.operation, input.model, input.nodeType, input.node.params ?? {});
  const fallbackMicrousd = fallbackCostMicrousd(input.kind);
  const baseCostMicrousd = integerMicrousd(catalogMatch?.baseCostMicrousd ?? fallbackMicrousd);
  const override = matchingPricingOverride({ provider: input.provider, operation: input.operation, model: input.model, nodeType: input.nodeType }, currentBillingPricingOverrides());
  return applyPricingMarkup({
    nodeId: input.node.id,
    title: input.node.title,
    nodeType: input.nodeType,
    provider: input.provider,
    operation: input.operation,
    model: input.model,
    free: false,
    providerCostMicrousd: baseCostMicrousd,
    baseCostMicrousd,
    baseCredits: creditsFromMicrousd(baseCostMicrousd),
    globalMarkupPercent: config.globalMarkupPercent,
    globalMarkupCredits: config.globalMarkupCredits,
    nodeMarkupPercent: override?.markupPercent ?? 0,
    nodeMarkupCredits: override?.markupCredits ?? 0,
    markupCredits: 0,
    finalCredits: 0,
    maxChargeCredits: 0,
    pricingSource: catalogMatch ? "pricing_catalog" : "fallback_estimate",
    pricingConfidence: catalogMatch ? pricingConfidenceForCatalogSource(catalogMatch.source) : "low",
    pricingSnapshotId: catalogMatch?.pricingSnapshotId ?? (catalogMatch ? pricingCatalogKey(catalogMatch) : fallbackPricingSnapshotId(input.provider, input.operation, input.model, input.nodeType)),
    parameterRules: catalogMatch?.parameterRules,
    canonicalModelId: catalogMatch?.canonicalModelId,
    providerNativeModelId: catalogMatch?.providerNativeModelId,
    fetchedAt: catalogMatch?.fetchedAt,
    staleAfter: catalogMatch?.staleAfter,
    fallback: !catalogMatch || catalogMatch.fallback === true,
    source: catalogMatch?.source ?? "fallback_estimate",
    notes: catalogMatch?.notes ?? "Fallback estimate; replace with provider pricing catalog or actual billing metadata."
  }, config);
}

function freePricingBreakdown(node: RouteNode, nodeType: string, operation: string, provider?: string, model?: string): PricingBreakdown {
  return {
    nodeId: node.id,
    title: node.title,
    nodeType,
    provider,
    operation,
    model,
    free: true,
    providerCostMicrousd: 0,
    baseCostMicrousd: 0,
    baseCredits: 0,
    globalMarkupPercent: 0,
    globalMarkupCredits: 0,
    nodeMarkupPercent: 0,
    nodeMarkupCredits: 0,
    markupCredits: 0,
    finalCredits: 0,
    maxChargeCredits: 0,
    pricingSource: "pricing_catalog",
    pricingConfidence: "high",
    fallback: false,
    source: "free_node"
  };
}

function applyPricingMarkup(input: PricingBreakdown, config: BillingPricingConfig = currentBillingPricingConfig()): PricingBreakdown {
  const globalPercentCredits = percentMarkupCredits(input.baseCredits, input.globalMarkupPercent);
  const nodePercentCredits = percentMarkupCredits(input.baseCredits, input.nodeMarkupPercent);
  const markupCredits = integerCredits(globalPercentCredits + input.globalMarkupCredits + nodePercentCredits + input.nodeMarkupCredits);
  const finalCredits = Math.max(0, input.free ? 0 : Math.max(config.minChargeCredits, input.baseCredits + markupCredits));
  return { ...input, markupCredits, finalCredits, maxChargeCredits: finalCredits };
}

function creditsFromMicrousd(providerCostMicrousd: number): number {
  return integerCredits(providerCostMicrousd / CREDIT_UNIT.microusdPerCredit);
}

function integerMicrousd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil(value));
}

function percentMarkupCredits(baseCredits: number, percent: number): number {
  if (!Number.isFinite(percent) || percent === 0) return 0;
  return Math.ceil((baseCredits * percent) / 100);
}

function findPricingCatalogEntry(provider: string | undefined, operation: string, model: string | undefined, nodeType: string, params: Record<string, unknown> = {}): ProviderPricingCatalogEntry | undefined {
  const entries = mergedProviderPricingCatalog().filter((entry) => entry.provider === provider && entry.operation === operation);
  const nodeTypeLower = nodeType.toLowerCase();
  return entries.find((entry) => modelMatchesPricingEntry(entry, model) && entry.parameterRules && pricingParameterRulesMatch(entry.parameterRules, params))
    ?? entries.find((entry) => modelMatchesPricingEntry(entry, model) && !entry.parameterRules)
    ?? entries.find((entry) => pricingEntryMatchesNodeType(entry, nodeTypeLower) && entry.parameterRules && pricingParameterRulesMatch(entry.parameterRules, params))
    ?? entries.find((entry) => !entry.model && entry.parameterRules && pricingParameterRulesMatch(entry.parameterRules, params))
    ?? entries.find((entry) => !entry.model);
}

function modelMatchesPricingEntry(entry: ProviderPricingCatalogEntry, model: string | undefined): boolean {
  if (!model) return false;
  const requestedAliases = modelAliases(model);
  return pricingEntryModelCandidates(entry).some((candidate) => {
    const aliases = modelAliases(candidate);
    return [...requestedAliases].some((alias) => aliases.has(alias));
  });
}

function pricingEntryMatchesNodeType(entry: ProviderPricingCatalogEntry, nodeTypeLower: string): boolean {
  return pricingEntryModelCandidates(entry).some((candidate) => nodeTypeLower.includes(candidate.toLowerCase()));
}

function pricingEntryModelCandidates(entry: ProviderPricingCatalogEntry): string[] {
  return [entry.model, entry.providerModelId, entry.providerNativeModelId, entry.canonicalModelId].filter((value): value is string => Boolean(value));
}

function modelAliases(model: string): Set<string> {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return new Set();
  const aliases = new Set([normalized]);
  const tail = normalized.split("/").filter(Boolean).at(-1);
  if (tail) aliases.add(tail);
  return aliases;
}

function pricingParameterRulesMatch(rules: Record<string, unknown> | undefined, params: Record<string, unknown>): boolean {
  if (!rules || Object.keys(rules).length === 0) return true;
  return Object.entries(rules).every(([key, expected]) => String(pricingParamValue(params, key) ?? "").toLowerCase() === String(expected).toLowerCase());
}

function pricingParamValue(params: Record<string, unknown>, key: string): unknown {
  if (key in params) return params[key];
  const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  if (camel in params) return params[camel];
  if (key === "image_resolution") return params.imageResolution ?? params.imageSize ?? params.resolution;
  return undefined;
}

function matchingPricingOverride(input: { provider?: string; operation?: string; model?: string; nodeType?: string }, overrides: BillingPricingOverride[]): BillingPricingOverride | undefined {
  return overrides.find((override) =>
    override.enabled !== false
    && (!override.provider || override.provider === input.provider)
    && (!override.operation || override.operation === input.operation)
    && (!override.model || override.model === input.model)
    && (!override.nodeType || override.nodeType === input.nodeType)
  );
}

function normalizePricingOverride(value: unknown): BillingPricingOverride | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    provider: typeof record.provider === "string" ? record.provider : undefined,
    operation: typeof record.operation === "string" ? record.operation : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    nodeType: typeof record.nodeType === "string" ? record.nodeType : undefined,
    markupPercent: numberValue(record.markupPercent, 0),
    markupCredits: integerCredits(numberValue(record.markupCredits, 0)),
    enabled: record.enabled !== false,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    updatedBy: typeof record.updatedBy === "string" ? record.updatedBy : undefined
  };
}

function mergedProviderPricingCatalog(): ProviderPricingCatalogEntry[] {
  const runtime = currentRuntimeProviderPricingCatalog();
  const runtimeKeys = new Set(runtime.map(pricingCatalogKey));
  return [...runtime, ...PROVIDER_PRICING_CATALOG.filter((entry) => !runtimeKeys.has(pricingCatalogKey(entry)))];
}

function pricingCatalogKey(entry: Pick<ProviderPricingCatalogEntry, "provider" | "operation" | "model">): string {
  return `${entry.provider}:${entry.operation}:${entry.model ?? "*"}`;
}

function normalizeRuntimeProviderPricingEntry(value: unknown): RuntimeProviderPricingCatalogEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const operation = typeof record.operation === "string" ? record.operation.trim() : "";
  const baseCostMicrousd = integerMicrousd(numberValue(record.baseCostMicrousd, 0));
  if (!provider || !operation || baseCostMicrousd <= 0) return null;
  return {
    provider,
    operation,
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined,
    parameterRules: record.parameterRules && typeof record.parameterRules === "object" ? record.parameterRules as Record<string, unknown> : undefined,
    baseCostMicrousd,
    currency: "USD",
    effectiveFrom: typeof record.effectiveFrom === "string" ? record.effectiveFrom : new Date(0).toISOString(),
    source: typeof record.source === "string" ? record.source : "runtime_pricing_catalog",
    canonicalModelId: typeof record.canonicalModelId === "string" ? record.canonicalModelId : undefined,
    providerModelId: typeof record.providerModelId === "string" ? record.providerModelId : undefined,
    providerNativeModelId: typeof record.providerNativeModelId === "string" ? record.providerNativeModelId : undefined,
    pricingSnapshotId: typeof record.pricingSnapshotId === "string" ? record.pricingSnapshotId : undefined,
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : undefined,
    staleAfter: typeof record.staleAfter === "string" ? record.staleAfter : undefined,
    fallback: record.fallback === true,
    notes: typeof record.notes === "string" ? record.notes : undefined
  };
}

function fallbackCostMicrousd(kind: "free" | "text" | "image" | "video" | "transform"): number {
  if (kind === "video") return 80000;
  if (kind === "image") return 40000;
  if (kind === "text") return 1000;
  return 0;
}

function microusdFromProviderCost(cost: number | null | undefined, currency: string | null | undefined): number | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) return null;
  const normalizedCurrency = (currency ?? "USD").toUpperCase();
  if (normalizedCurrency === "RUB") return Math.ceil((cost / rubPerUsd()) * 1_000_000);
  if (normalizedCurrency !== "USD") return null;
  return Math.ceil(cost * 1_000_000);
}

function rubPerUsd(): number {
  const value = Number(process.env.BOOJUM_RUB_PER_USD ?? 100);
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function numberFromEnv(name: string, fallback: number): number {
  return numberValue(process.env[name], fallback);
}

function numberValue(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
}

function operationFromNodeType(type: string, kind: "free" | "text" | "image" | "video" | "transform"): string {
  if (/upscale/i.test(type)) return "image.upscale";
  if (kind === "video") return "video.generate";
  if (kind === "image") return "image.generate";
  if (kind === "text") return "text.generate";
  return "utility.local";
}

function modelForPricing(node: RouteNode): string | undefined {
  const explicitModel = stringParam((node.params ?? {}).model);
  if (explicitModel) return explicitModel;
  if (node.type === "replicate.clarity-upscaler") return "clarity-upscaler";
  if (node.type === "gemini.nano-banana-2") return "gemini-3.1-flash-image-preview";
  return undefined;
}

function fallbackPricingSnapshotId(provider: string | undefined, operation: string, model: string | undefined, nodeType: string): string {
  return `fallback:${provider ?? "unknown"}:${operation}:${model ?? nodeType}`;
}

function pricingConfidenceForCatalogSource(source: string): PricingConfidence {
  if (source === "manual_catalog") return "high";
  if (source === "manual_initial_estimate") return "medium";
  if (source === "fallback_estimate") return "low";
  if (/estimate/i.test(source)) return "medium";
  return "high";
}

function integerCredits(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil(value));
}

function providerFromNodeType(type: string): string | undefined {
  if (/openrouter/i.test(type)) return "openrouter";
  if (/polza/i.test(type)) return "polza";
  if (/gemini/i.test(type)) return "gemini";
  if (/replicate/i.test(type)) return "replicate";
  if (/seedance/i.test(type)) return "seedance";
  return undefined;
}

function providerForPricing(node: RouteNode): string | undefined {
  const params = node.params ?? {};
  return stringParam(params.provider)
    ?? stringParam(params.executionProvider)
    ?? stringParam(params.providerId)
    ?? providerFromProviderMode(params.providerMode)
    ?? providerFromNodeType(node.type);
}

function providerFromProviderMode(value: unknown): string | undefined {
  const providerMode = stringParam(value);
  if (providerMode === "openrouter") return "openrouter";
  if (providerMode === "direct") return undefined;
  if (providerMode === "auto") return undefined;
  return providerMode;
}

function numberMetric(metrics: Record<string, unknown>, key: string): number | undefined {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    const resolvedTemplates = value.replace(TEMPLATE_REF_PATTERN, (match, nodeId: string, path: string) => {
      if (!(nodeId in context)) {
        throw new Error(`Template reference "${match}" points to missing or not-yet-executed node "${nodeId}". Add an edge from "${nodeId}" to this node.`);
      }
      const resolved = readPath(context[nodeId], path);
      if (resolved === undefined) {
        throw new Error(`Template reference "${match}" points to missing output field "${path}" on node "${nodeId}".`);
      }
      return resolved === null ? "" : String(resolved);
    });
    return resolveTextChipReferences(resolvedTemplates, context);
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
const TEXT_CHIP_REF_PATTERN = /\[\[text:([^\]]+)\]\]/g;

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
    for (const match of value.matchAll(TEXT_CHIP_REF_PATTERN)) {
      const ref = parseTextChipReference(match[1].trim());
      refs.push({ nodeId: ref.nodeId, path: ref.path, raw: match[0] });
    }
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

function resolveTextChipReferences(value: string, context: Record<string, unknown>): string {
  return value.replace(TEXT_CHIP_REF_PATTERN, (match, rawRef: string) => {
    const ref = parseTextChipReference(rawRef.trim());
    if (!(ref.nodeId in context)) {
      throw new Error(`Text chip reference "${match}" points to missing or not-yet-executed node "${ref.nodeId}". Add an edge from "${ref.nodeId}" to this node.`);
    }
    const resolved = readOutputPort(context[ref.nodeId], ref.path);
    if (resolved === undefined) {
      throw new Error(`Text chip reference "${match}" points to missing output field "${ref.path}" on node "${ref.nodeId}".`);
    }
    return resolved === null ? "" : String(resolved);
  });
}

function parseTextChipReference(rawRef: string): { nodeId: string; path: string } {
  const separatorIndex = Math.max(rawRef.lastIndexOf(":"), rawRef.lastIndexOf("."));
  if (separatorIndex <= 0) return { nodeId: rawRef, path: "text" };
  return { nodeId: rawRef.slice(0, separatorIndex), path: rawRef.slice(separatorIndex + 1) || "text" };
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
