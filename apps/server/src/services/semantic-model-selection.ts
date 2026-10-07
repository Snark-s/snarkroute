import {
  DECISION_PROTOCOL,
  DecisionDispatcher,
  EngineRequirementBuilder,
  ModelGateway,
  ModelRegistry,
  RulesDecisionAdapter,
  SemanticEngineSelector,
  type EngineConstraints,
  type EngineDomain,
  type EngineOperation,
  type EnginePreferences,
  type EngineSelectionTrace,
  type DecisionExecutor,
  type ModelInfo,
  type ProviderConnection
} from "@snarkroute/core";
import type {
  ModelOptionForNodeV1,
  ModelProviderRouteV1,
  SuppliedModelInputsV1
} from "@snarkroute/model-catalog/dist/v1/index.js";

export interface SemanticModelSelectionInputV1 {
  nodeType: string;
  prompt?: string;
  operation?: EngineOperation;
  inputs?: SuppliedModelInputsV1 & { text?: boolean; imageRoles?: string[] };
  manualModelRef?: string;
  preferences?: EnginePreferences;
  constraints?: EngineConstraints;
}

export interface SelectedModelRouteV1 {
  engineId: string;
  modelId: string;
  storedModelId: string;
  provider: string;
  providerModelId: string;
}

export interface SemanticModelSelectionResultV1 {
  status: "ok" | "unsupported";
  selection?: SelectedModelRouteV1;
  selectedModelId?: string;
  selectedRouteId?: string;
  selectedStoredModelId?: string;
  selectedProvider?: string;
  selectedProviderModelId?: string;
  models: ModelOptionForNodeV1[];
  requirements: Awaited<ReturnType<EngineRequirementBuilder["build"]>>["requirements"];
  trace: EngineSelectionTrace;
}

interface EngineProjection {
  engine: ModelInfo;
  option: ModelOptionForNodeV1;
  optionIndex: number;
  route?: ModelProviderRouteV1;
  routeIndex?: number;
}

const semanticRulesDispatcher = new DecisionDispatcher(
  new ModelRegistry([{
    id: "semantic-rules",
    providerId: "local",
    title: "Semantic requirement rules",
    kind: "decision",
    protocols: [DECISION_PROTOCOL],
    capabilities: ["decision.rank"],
    availability: "available",
    priority: 0,
    adapterId: "semantic-rules"
  }]),
  [new RulesDecisionAdapter({ id: "semantic-rules" })]
);

/**
 * Applies semantic requirements to the already-compatible options produced by
 * modelOptionsForNodeV1. It deliberately does not create another catalog or
 * provider router: the selected option and physical route are promoted inside
 * the existing response consumed by the current first-option Auto-select.
 */
export async function selectSemanticModelOptionV1(
  options: ModelOptionForNodeV1[],
  input: SemanticModelSelectionInputV1,
  decisionExecutor: DecisionExecutor = semanticRulesDispatcher
): Promise<SemanticModelSelectionResultV1> {
  const projections = projectEngines(options, input.nodeType);
  const gateway = new ModelGateway({
    models: projections.map(({ engine }) => engine),
    connections: providerConnections(projections)
  });
  const builder = new EngineRequirementBuilder(decisionExecutor);
  const selector = new SemanticEngineSelector(gateway, builder);
  const manualModelRef = input.manualModelRef
    ? resolveManualEngineId(input.manualModelRef, projections) ?? input.manualModelRef
    : undefined;
  const inputFacts = inputFactsForNode(input);
  const selected = await selector.select({
    prompt: input.prompt,
    targetDomain: domainForNode(input.nodeType, options),
    explicitOperation: input.operation,
    inputs: inputFacts,
    manualModelRef,
    preferences: input.preferences,
    constraints: input.constraints,
    metadata: { nodeType: input.nodeType }
  });
  const projection = selected.selected
    ? projections.find((candidate) => candidate.engine.id === selected.selected?.id)
    : undefined;
  const models = projection ? promoteSelection(options, projection) : [...options];
  const selection = projection ? selectedRoute(projection) : undefined;
  const requirements = input.manualModelRef
    ? { ...selected.requirements, manualModelRef: input.manualModelRef }
    : selected.requirements;
  const trace = input.manualModelRef
    ? { ...selected.trace, requirements: { ...selected.trace.requirements, manualModelRef: input.manualModelRef } }
    : selected.trace;

  return {
    status: selected.status,
    selection,
    selectedModelId: selection?.modelId,
    selectedRouteId: selection?.engineId,
    selectedStoredModelId: selection?.storedModelId,
    selectedProvider: selection?.provider,
    selectedProviderModelId: selection?.providerModelId,
    models,
    requirements,
    trace
  };
}

function inputFactsForNode(input: SemanticModelSelectionInputV1) {
  return {
    text: input.inputs?.text ?? Boolean(input.prompt?.trim()),
    imageCount: input.inputs?.image ?? (input.nodeType === "local_upscale" ? 1 : undefined),
    videoCount: input.inputs?.video ?? (input.nodeType === "local_video_upscale" ? 1 : undefined),
    audioCount: input.inputs?.audio,
    imageRoles: input.inputs?.imageRoles
  };
}

function projectEngines(options: ModelOptionForNodeV1[], nodeType: string): EngineProjection[] {
  return options.flatMap((option, optionIndex) => {
    const routes = option.providerRoutes?.length ? option.providerRoutes : [undefined];
    return routes.map((route, routeIndex): EngineProjection => {
      const provider = route?.provider ?? option.executionProvider ?? option.provider;
      const providerModelId = route?.providerModelId ?? option.providerModelId;
      const metadata = { ...(option.metadata ?? {}), ...(route?.metadata ?? {}) };
      const constraints = recordValue(metadata.providerConstraints);
      const limits = { ...constraints, ...(route?.constraints ?? {}), ...recordValue(metadata.limits) };
      return {
        option,
        optionIndex,
        route,
        routeIndex: route ? routeIndex : undefined,
        engine: {
          id: engineId(option.id, provider, providerModelId),
          providerId: provider,
          title: option.displayName,
          kind: domainForNode(nodeType, [option]),
          capabilities: [...(route?.capabilities ?? option.capabilities)],
          availability: availability(route?.availability ?? option.availability),
          priority: finiteNumber(metadata.priority),
          limits: Object.keys(limits).length ? limits : undefined,
          inputTypes: [...(route?.inputTypes ?? option.inputTypes)],
          outputTypes: [...(route?.outputTypes ?? option.outputTypes)],
          ioContract: route?.ioContract ?? option.ioContract ?? option.inputContract,
          pricingHint: stringHint(metadata.costHint ?? metadata.pricingTier),
          qualityHint: hint(metadata.qualityHint ?? metadata.quality),
          speedHint: hint(metadata.speedHint ?? metadata.speed),
          metadata: {
            ...metadata,
            catalogModelId: option.id,
            storedModelId: route?.storedModelId ?? option.storedModelId,
            providerModelId
          }
        }
      };
    });
  });
}

function providerConnections(projections: EngineProjection[]): ProviderConnection[] {
  const enabled = new Map<string, boolean>();
  for (const projection of projections) {
    const available = projection.engine.availability === "available"
      && (projection.route?.availability.configured ?? projection.option.availability.configured) !== false;
    enabled.set(projection.engine.providerId, (enabled.get(projection.engine.providerId) ?? false) || available);
  }
  return [...enabled].map(([providerId, isEnabled]) => ({ providerId, enabled: isEnabled }));
}

function resolveManualEngineId(modelRef: string, projections: EngineProjection[]): string | undefined {
  const normalized = modelRef.trim();
  return projections.find(({ engine, option, route }) => {
    const providerModelId = route?.providerModelId ?? option.providerModelId;
    const provider = route?.provider ?? option.executionProvider ?? option.provider;
    return [
      engine.id,
      option.id,
      option.storedModelId,
      option.providerModelId,
      route?.storedModelId,
      route?.providerModelId,
      `model://${provider}/${providerModelId}`
    ].includes(normalized);
  })?.engine.id;
}

function promoteSelection(options: ModelOptionForNodeV1[], projection: EngineProjection): ModelOptionForNodeV1[] {
  const selected = options[projection.optionIndex];
  const promotedRoutes = projection.route && selected.providerRoutes
    ? [projection.route, ...selected.providerRoutes.filter((_, index) => index !== projection.routeIndex)]
    : selected.providerRoutes;
  const promoted = promotedRoutes === selected.providerRoutes ? selected : { ...selected, providerRoutes: promotedRoutes };
  return [promoted, ...options.filter((_, index) => index !== projection.optionIndex)];
}

function selectedRoute(projection: EngineProjection): SelectedModelRouteV1 {
  return {
    engineId: projection.engine.id,
    modelId: projection.option.id,
    storedModelId: projection.route?.storedModelId ?? projection.option.storedModelId,
    provider: projection.route?.provider ?? projection.option.executionProvider ?? projection.option.provider,
    providerModelId: projection.route?.providerModelId ?? projection.option.providerModelId
  };
}

function domainForNode(nodeType: string, options: ModelOptionForNodeV1[]): EngineDomain | undefined {
  if (nodeType === "local_upscale" || nodeType === "local_video_upscale") return "upscale";
  if (nodeType.includes("video")) return "video";
  if (nodeType.includes("image")) return "image";
  if (nodeType.includes("audio")) return "audio";
  if (nodeType === "ai.3d.generate" || nodeType.includes("3d")) return "model";
  if (nodeType.includes("text")) return "text";
  const outputs = new Set(options.flatMap((option) => option.outputTypes));
  for (const domain of ["text", "image", "video", "audio", "model"] as const) {
    if (outputs.has(domain)) return domain;
  }
  return undefined;
}

function availability(value: ModelOptionForNodeV1["availability"]): ModelInfo["availability"] {
  return value.status;
}

function engineId(modelId: string, provider: string, providerModelId: string): string {
  return `${modelId}::${provider}::${providerModelId}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringHint(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hint(value: unknown): ModelInfo["qualityHint"] {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
