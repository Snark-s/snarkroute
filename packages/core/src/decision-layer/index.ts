import {
  ModelGateway,
  ModelRegistry,
  type ModelCapability,
  type ModelInfo,
  type ModelInvokeRequest
} from "../model-gateway";
import {
  DECISION_PROTOCOL,
  type DecisionCandidate,
  type DecisionConstraints,
  type DecisionOperation,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionStatus
} from "@snarkroute/protocol";

export {
  DECISION_OPERATIONS,
  DECISION_PROTOCOL,
  DecisionCandidateSchema,
  DecisionConstraintsSchema,
  DecisionDiagnosticsSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  DecisionResultSchema,
  DecisionStatusSchema
} from "@snarkroute/protocol";
export type {
  DecisionCandidate,
  DecisionConstraints,
  DecisionDiagnostics,
  DecisionOperation,
  DecisionRequest,
  DecisionResponse,
  DecisionResult,
  DecisionStatus
} from "@snarkroute/protocol";

export interface DecisionAdapterContext {
  engine: ModelInfo;
  signal: AbortSignal;
}

export interface DecisionAdapter {
  id: string;
  supports(engine: ModelInfo, request: DecisionRequest): boolean;
  execute(request: DecisionRequest, context: DecisionAdapterContext): Promise<DecisionResponse>;
  health?(engine: ModelInfo): Promise<boolean | { available: boolean; status?: string }>;
}

export interface DecisionExecutor {
  execute(request: DecisionRequest, policy?: DecisionFallbackPolicy): Promise<DecisionResponse>;
}

export interface DecisionFallbackPolicy {
  engineIds?: string[];
  fallbackOn?: DecisionStatus[];
  maxAttempts?: number;
  confidenceThreshold?: number;
  timeoutMs?: number;
}

export interface DecisionExecutionObservation {
  operation: DecisionOperation;
  backend: string;
  provider: string;
  latencyMs: number;
  status: DecisionStatus;
  confidence?: number;
  fallbackCount: number;
  fallbackPath: string[];
  fallbackReason?: DecisionStatus;
  cost?: number;
}

export interface DecisionDispatcherOptions {
  fallback?: DecisionFallbackPolicy;
  onObservation?: (observation: DecisionExecutionObservation) => void;
}

const DEFAULT_FALLBACK_STATUSES: DecisionStatus[] = ["error", "timeout", "unsupported", "low_confidence"];

export function decisionCapability(operation: DecisionOperation): ModelCapability {
  return `decision.${operation}`;
}

export class DecisionDispatcher {
  readonly #adapters = new Map<string, DecisionAdapter>();
  readonly #fallback: Required<Omit<DecisionFallbackPolicy, "engineIds">> & Pick<DecisionFallbackPolicy, "engineIds">;
  readonly #onObservation?: DecisionDispatcherOptions["onObservation"];

  constructor(readonly registry: ModelRegistry, adapters: DecisionAdapter[] = [], options: DecisionDispatcherOptions = {}) {
    for (const adapter of adapters) this.#adapters.set(adapter.id, adapter);
    this.#fallback = {
      engineIds: options.fallback?.engineIds,
      fallbackOn: options.fallback?.fallbackOn ?? DEFAULT_FALLBACK_STATUSES,
      maxAttempts: positiveInteger(options.fallback?.maxAttempts, 8),
      confidenceThreshold: clampConfidence(options.fallback?.confidenceThreshold ?? 0),
      timeoutMs: positiveInteger(options.fallback?.timeoutMs, 30_000)
    };
    this.#onObservation = options.onObservation;
  }

  registerAdapter(adapter: DecisionAdapter): void {
    this.#adapters.set(adapter.id, adapter);
  }

  findBackends(operation: DecisionOperation): ModelInfo[] {
    const acceptedCapabilities = new Set<ModelCapability>([decisionCapability(operation), operation]);
    return this.registry
      .findByProtocol(DECISION_PROTOCOL)
      .filter((engine) => engine.kind === "decision")
      .filter((engine) => engine.capabilities.some((capability) => acceptedCapabilities.has(capability)))
      .filter(isDeclaredAvailable)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  async execute(request: DecisionRequest, policy: DecisionFallbackPolicy = {}): Promise<DecisionResponse> {
    const validationError = validateRequest(request);
    if (validationError) return { status: "error", results: [], message: validationError, diagnostics: { reason: "invalid_request" } };

    const effective = mergePolicy(this.#fallback, policy, request.constraints);
    const backends = orderBackends(this.findBackends(request.operation), effective.engineIds);
    if (backends.length === 0) {
      return { status: "unsupported", results: [], message: `No available ${DECISION_PROTOCOL} backend supports "${request.operation}".` };
    }

    const attempted = new Set<string>();
    const fallbackPath: string[] = [];
    let lastResponse: DecisionResponse = { status: "unsupported", results: [] };
    let fallbackReason: DecisionStatus | undefined;

    for (const engine of backends) {
      if (attempted.size >= effective.maxAttempts || attempted.has(engine.id)) continue;
      attempted.add(engine.id);

      const adapterId = engine.adapterId ?? engine.providerId;
      const adapter = this.#adapters.get(adapterId);
      const timeoutMs = positiveInteger(request.constraints?.timeoutMs, effective.timeoutMs);
      if (!adapter || !adapter.supports(engine, request) || !(await adapterIsAvailable(adapter, engine, timeoutMs))) continue;

      const startedAt = Date.now();
      let response = await invokeWithTimeout(adapter, engine, request, timeoutMs);
      response = normalizeResponse(response, engine);
      const threshold = clampConfidence(request.constraints?.confidenceThreshold ?? effective.confidenceThreshold);
      if (response.status === "ok" && response.confidence !== undefined && response.confidence < threshold) {
        response = { ...response, status: "low_confidence", diagnostics: { ...response.diagnostics, reason: "confidence_threshold" } };
      }

      fallbackPath.push(engine.id);
      const fallbackCount = fallbackPath.length - 1;
      this.#onObservation?.({
        operation: request.operation,
        backend: engine.id,
        provider: engine.providerId,
        latencyMs: Date.now() - startedAt,
        status: response.status,
        confidence: response.confidence,
        fallbackCount,
        fallbackPath: [...fallbackPath],
        fallbackReason,
        cost: typeof response.diagnostics?.cost === "number" ? response.diagnostics.cost : undefined
      });

      lastResponse = response;
      if (!effective.fallbackOn.includes(response.status)) return response;
      fallbackReason = response.status;
    }

    return lastResponse;
  }
}

export interface RulesDecisionRule {
  candidateId: string;
  keywords: string[];
  score?: number;
}

export interface RulesDecisionAdapterOptions {
  id?: string;
  rules?: RulesDecisionRule[];
}

export class RulesDecisionAdapter implements DecisionAdapter {
  readonly id: string;
  readonly #rules: RulesDecisionRule[];

  constructor(options: RulesDecisionAdapterOptions = {}) {
    this.id = options.id ?? "rules";
    this.#rules = options.rules ?? [];
  }

  supports(_engine: ModelInfo, request: DecisionRequest): boolean {
    return request.operation === "select_one" || request.operation === "rank" || request.operation === "classify" || request.operation === "score";
  }

  async health(): Promise<{ available: true; status: "available" }> {
    return { available: true, status: "available" };
  }

  async execute(request: DecisionRequest): Promise<DecisionResponse> {
    if (!request.candidates?.length) return { status: "unsupported", results: [], message: "Rules decisions require candidates." };
    if (!this.supports({} as ModelInfo, request)) return { status: "unsupported", results: [] };

    const haystack = searchableText(request.input);
    const scored = request.candidates.map((candidate, index) => ({
      id: candidate.id,
      score: candidateScore(candidate, haystack, this.#rules),
      index
    })).sort((a, b) => b.score - a.score || a.index - b.index);
    const confidence = scored[0]?.score ?? 0;

    if (confidence <= 0 && request.constraints?.allowAbstain) {
      return { status: "abstain", results: [], confidence: 0 };
    }

    const defaultTopK = request.operation === "select_one" || request.operation === "classify" ? 1 : scored.length;
    const topK = Math.min(scored.length, positiveInteger(request.constraints?.topK, defaultTopK));
    return {
      status: "ok",
      results: scored.slice(0, topK).map(({ id, score }) => ({ id, score })),
      confidence,
      diagnostics: { confidenceSource: "rules", confidenceKind: "heuristic" }
    };
  }
}

export interface ModelGatewayDecisionAdapterOptions {
  id?: string;
  capability?: ModelCapability;
  defaultModelRef?: string;
}

export class ModelGatewayDecisionAdapter implements DecisionAdapter {
  readonly id: string;
  readonly #capability: ModelCapability;
  readonly #defaultModelRef?: string;

  constructor(private readonly gateway: ModelGateway, options: ModelGatewayDecisionAdapterOptions = {}) {
    this.id = options.id ?? "model-gateway";
    this.#capability = options.capability ?? "text.generate";
    this.#defaultModelRef = options.defaultModelRef;
  }

  supports(): boolean {
    return true;
  }

  async execute(request: DecisionRequest, context: DecisionAdapterContext): Promise<DecisionResponse> {
    const configuredModelRef = typeof context.engine.metadata?.modelRef === "string" ? context.engine.metadata.modelRef : undefined;
    const gatewayRequest: ModelInvokeRequest = {
      capability: this.#capability,
      modelRef: configuredModelRef ?? this.#defaultModelRef,
      input: { prompt: decisionPrompt(request) },
      parameters: { responseFormat: "json" },
      metadata: { protocol: DECISION_PROTOCOL, operation: request.operation }
    };
    let estimatedCost: number | undefined;
    try {
      const quote = this.gateway.quoteSelectedRoute(gatewayRequest);
      estimatedCost = quote.estimatedCost ?? undefined;
    } catch {
      // Pricing is optional and must never prevent the decision itself.
    }
    const result = await this.gateway.invoke(gatewayRequest);
    const response = responseFromGatewayOutput(result.output);
    return estimatedCost === undefined
      ? response
      : { ...response, diagnostics: { ...response.diagnostics, cost: estimatedCost } };
  }
}

function candidateScore(candidate: DecisionCandidate, haystack: string, rules: RulesDecisionRule[]): number {
  const configured = rules.filter((rule) => rule.candidateId === candidate.id);
  const metadataKeywords = Array.isArray(candidate.metadata?.keywords)
    ? candidate.metadata.keywords.filter((keyword): keyword is string => typeof keyword === "string")
    : [];
  const valueKeywords = typeof candidate.value === "string" ? [candidate.value] : [];
  const allRules = configured.length > 0
    ? configured
    : [{ candidateId: candidate.id, keywords: [...metadataKeywords, ...valueKeywords], score: 1 }];
  let matchedScore = 0;
  let possibleScore = 0;
  for (const rule of allRules) {
    const weight = rule.score ?? 1;
    possibleScore += Math.max(1, rule.keywords.length) * weight;
    matchedScore += rule.keywords.reduce((total, keyword) => total + (haystack.includes(keyword.toLowerCase()) ? weight : 0), 0);
  }
  return possibleScore > 0 ? clampConfidence(matchedScore / possibleScore) : 0;
}

function searchableText(input: unknown): string {
  if (typeof input === "string") return input.toLowerCase();
  try {
    return JSON.stringify(input).toLowerCase();
  } catch {
    return String(input).toLowerCase();
  }
}

function validateRequest(request: DecisionRequest): string | undefined {
  if (!request.operation) return "Decision operation is required.";
  const ids = new Set<string>();
  for (const candidate of request.candidates ?? []) {
    if (!candidate.id.trim()) return "Decision candidate IDs must be non-empty.";
    if (ids.has(candidate.id)) return `Decision candidate ID "${candidate.id}" is duplicated.`;
    ids.add(candidate.id);
  }
  return undefined;
}

function isDeclaredAvailable(engine: ModelInfo): boolean {
  return engine.availability !== "unavailable";
}

async function adapterIsAvailable(adapter: DecisionAdapter, engine: ModelInfo, timeoutMs: number): Promise<boolean> {
  if (!adapter.health) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const health = await Promise.race([
      adapter.health(engine),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
    return typeof health === "boolean" ? health : health.available;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invokeWithTimeout(adapter: DecisionAdapter, engine: ModelInfo, request: DecisionRequest, timeoutMs: number): Promise<DecisionResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.execute(request, { engine, signal: controller.signal }),
      new Promise<DecisionResponse>((resolve) => {
        timer = setTimeout(() => {
          resolve({ status: "timeout", results: [], message: "Decision backend timed out.", diagnostics: { reason: "timeout" } });
          controller.abort();
        }, timeoutMs);
      })
    ]);
  } catch {
    return { status: "error", results: [], message: "Decision backend failed.", diagnostics: { reason: "adapter_error" } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeResponse(response: DecisionResponse, engine: ModelInfo): DecisionResponse {
  const statuses: DecisionStatus[] = ["ok", "abstain", "low_confidence", "unsupported", "timeout", "error"];
  if (!response || !statuses.includes(response.status) || !Array.isArray(response.results)) {
    return { status: "error", results: [], backend: engine.id, message: "Decision backend returned an invalid response.", diagnostics: { reason: "invalid_response" } };
  }
  return {
    ...response,
    backend: engine.id,
    results: response.results.filter((result) => typeof result?.id === "string" && result.id.length > 0),
    confidence: response.confidence === undefined ? undefined : clampConfidence(response.confidence),
    diagnostics: { provider: engine.providerId, ...response.diagnostics }
  };
}

function orderBackends(backends: ModelInfo[], engineIds: string[] | undefined): ModelInfo[] {
  if (!engineIds?.length) return backends;
  const byId = new Map(backends.map((engine) => [engine.id, engine]));
  const ordered: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const id of engineIds) {
    const engine = byId.get(id);
    if (engine && !seen.has(id)) {
      ordered.push(engine);
      seen.add(id);
    }
  }
  return ordered;
}

function mergePolicy(
  defaults: Required<Omit<DecisionFallbackPolicy, "engineIds">> & Pick<DecisionFallbackPolicy, "engineIds">,
  policy: DecisionFallbackPolicy,
  constraints: DecisionConstraints | undefined
): Required<Omit<DecisionFallbackPolicy, "engineIds">> & Pick<DecisionFallbackPolicy, "engineIds"> {
  return {
    engineIds: policy.engineIds ?? defaults.engineIds,
    fallbackOn: policy.fallbackOn ?? defaults.fallbackOn,
    maxAttempts: positiveInteger(policy.maxAttempts, defaults.maxAttempts),
    confidenceThreshold: clampConfidence(policy.confidenceThreshold ?? constraints?.confidenceThreshold ?? defaults.confidenceThreshold),
    timeoutMs: positiveInteger(policy.timeoutMs ?? constraints?.timeoutMs, defaults.timeoutMs)
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function decisionPrompt(request: DecisionRequest): string {
  return [
    `Execute ${DECISION_PROTOCOL}.`,
    "Return JSON only with status, results, and optional confidence.",
    "Allowed statuses: ok, abstain, low_confidence, unsupported, timeout, error.",
    JSON.stringify(request)
  ].join("\n");
}

function responseFromGatewayOutput(output: Record<string, unknown>): DecisionResponse {
  const nested = isRecord(output.decision) ? output.decision : output;
  if (typeof nested.status === "string" && Array.isArray(nested.results)) return nested as unknown as DecisionResponse;
  const text = typeof output.text === "string" ? output.text : typeof output.content === "string" ? output.content : undefined;
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed) && typeof parsed.status === "string" && Array.isArray(parsed.results)) return parsed as unknown as DecisionResponse;
    } catch {
      return { status: "error", results: [], message: "Model Gateway returned invalid decision JSON.", diagnostics: { reason: "invalid_json" } };
    }
  }
  return { status: "error", results: [], message: "Model Gateway returned an invalid decision response.", diagnostics: { reason: "invalid_response" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
