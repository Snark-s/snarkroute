import type {
  DecisionExecutor,
  DecisionFallbackPolicy,
  DecisionOperation,
  DecisionRequest,
  DecisionResponse,
  DecisionStatus
} from "../decision-layer";

export type ConfidenceProvenance = "provider" | "derived" | "derived_from_probability" | "unavailable" | string;

export interface DecisionResultSummary {
  status: DecisionStatus;
  confidence?: number;
  resultIds: string[];
  scores: Array<number | null>;
  valueFingerprints?: string[];
}

export interface DecisionAgreement {
  comparable: boolean;
  agreed?: boolean;
  score?: number;
  method: "top_one" | "normalized_score" | "probability_threshold" | "top_k_overlap" | "structural" | "status" | "not_comparable";
  details?: Record<string, number | boolean>;
}

export interface DecisionConfidenceRecord {
  value?: number;
  source: ConfidenceProvenance;
  kind: "native" | "calibrated" | "heuristic" | "derived" | "self_reported" | "absent" | string;
}

export interface DecisionBenchmarkRecord {
  id: string;
  timestamp: string;
  requestFingerprint: string;
  operation: DecisionOperation;
  productionBackend: string;
  shadowBackend: string;
  productionProvider: string;
  shadowProvider: string;
  productionModel: string;
  shadowModel: string;
  productionResult: DecisionResultSummary;
  shadowResult: DecisionResultSummary;
  productionLatencyMs: number;
  shadowLatencyMs: number;
  agreement: DecisionAgreement;
  confidenceProvenance: { production: ConfidenceProvenance; shadow: ConfidenceProvenance };
  confidence: { production: DecisionConfidenceRecord; shadow: DecisionConfidenceRecord };
  groundTruth?: unknown;
  evaluationOutcome?: unknown;
}

export interface DecisionBenchmarkStore {
  append(record: DecisionBenchmarkRecord): void | Promise<void>;
  list(): DecisionBenchmarkRecord[];
}

export class InMemoryDecisionBenchmarkStore implements DecisionBenchmarkStore {
  readonly #records: DecisionBenchmarkRecord[] = [];

  constructor(private readonly limit = 1_000) {}

  get records(): DecisionBenchmarkRecord[] {
    return this.list();
  }

  append(record: DecisionBenchmarkRecord): void {
    this.#records.push(record);
    if (this.#records.length > this.limit) this.#records.splice(0, this.#records.length - this.limit);
  }

  list(): DecisionBenchmarkRecord[] {
    return this.#records.map((record) => structuredClone(record));
  }
}

export interface DecisionShadowBenchmarkOptions {
  enabled?: boolean;
  backendIds?: string[];
  sampleRate?: number;
  timeoutMs?: number;
  store?: DecisionBenchmarkStore;
  random?: () => number;
  now?: () => number;
  onRecord?: (record: DecisionBenchmarkRecord) => void;
  evaluate?: (
    request: DecisionRequest,
    production: DecisionResponse,
    shadow: DecisionResponse
  ) => void | { groundTruth?: unknown; evaluationOutcome?: unknown } | Promise<void | { groundTruth?: unknown; evaluationOutcome?: unknown }>;
}

export class DecisionShadowBenchmark implements DecisionExecutor {
  readonly #enabled: boolean;
  readonly #backendIds: string[];
  readonly #sampleRate: number;
  readonly #timeoutMs: number;
  readonly #store: DecisionBenchmarkStore;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #onRecord?: (record: DecisionBenchmarkRecord) => void;
  readonly #evaluate?: DecisionShadowBenchmarkOptions["evaluate"];
  readonly #pending = new Set<Promise<void>>();
  #sequence = 0;

  constructor(
    private readonly production: DecisionExecutor,
    private readonly shadow: DecisionExecutor,
    options: DecisionShadowBenchmarkOptions = {}
  ) {
    this.#enabled = options.enabled ?? false;
    this.#backendIds = unique(options.backendIds ?? []);
    this.#sampleRate = clamp01(options.sampleRate ?? 0);
    this.#timeoutMs = positiveInteger(options.timeoutMs, 10_000);
    this.#store = options.store ?? new InMemoryDecisionBenchmarkStore();
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#onRecord = options.onRecord;
    this.#evaluate = options.evaluate;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get records(): DecisionBenchmarkRecord[] {
    return this.#store.list();
  }

  async execute(request: DecisionRequest, policy: DecisionFallbackPolicy = {}): Promise<DecisionResponse> {
    const productionStarted = this.#now();
    const productionResult = await this.production.execute(request, policy);
    const productionLatencyMs = Math.max(0, this.#now() - productionStarted);
    if (!this.#enabled || this.#backendIds.length === 0 || this.#sampleRate <= 0 || this.#random() >= this.#sampleRate) {
      return productionResult;
    }

    for (const backendId of this.#backendIds) {
      if (backendId === productionResult.backend) continue;
      const task = this.#runShadow(request, productionResult, productionLatencyMs, backendId)
        .catch(() => undefined)
        .finally(() => this.#pending.delete(task));
      this.#pending.add(task);
    }
    return productionResult;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  async close(): Promise<void> {
    await this.drain();
  }

  async #runShadow(request: DecisionRequest, productionResult: DecisionResponse, productionLatencyMs: number, backendId: string): Promise<void> {
    const started = this.#now();
    let shadowResult: DecisionResponse;
    try {
      shadowResult = await withDeadline(
        this.shadow.execute(request, {
          engineIds: [backendId],
          maxAttempts: 1,
          timeoutMs: this.#timeoutMs,
          fallbackOn: []
        }),
        this.#timeoutMs,
        { status: "timeout", backend: backendId, results: [], diagnostics: { reason: "shadow_timeout" } }
      );
    } catch {
      shadowResult = { status: "error", backend: backendId, results: [], diagnostics: { reason: "shadow_exception" } };
    }
    let evaluation: void | { groundTruth?: unknown; evaluationOutcome?: unknown };
    try {
      evaluation = this.#evaluate
        ? await withDeadline(Promise.resolve(this.#evaluate(request, productionResult, shadowResult)), this.#timeoutMs, undefined)
        : undefined;
    } catch {
      evaluation = { evaluationOutcome: { status: "evaluation_error" } };
    }
    const record: DecisionBenchmarkRecord = {
      id: `decision-shadow-${this.#now()}-${++this.#sequence}`,
      timestamp: new Date(this.#now()).toISOString(),
      requestFingerprint: fingerprintDecisionRequest(request),
      operation: request.operation,
      productionBackend: productionResult.backend ?? "unknown",
      shadowBackend: shadowResult.backend ?? backendId,
      productionProvider: diagnosticIdentifier(productionResult, "provider"),
      shadowProvider: diagnosticIdentifier(shadowResult, "provider"),
      productionModel: diagnosticIdentifier(productionResult, "providerModel"),
      shadowModel: diagnosticIdentifier(shadowResult, "providerModel"),
      productionResult: summarize(productionResult),
      shadowResult: summarize(shadowResult),
      productionLatencyMs,
      shadowLatencyMs: Math.max(0, this.#now() - started),
      agreement: compareDecisionResults(request.operation, productionResult, shadowResult),
      confidenceProvenance: {
        production: confidenceProvenance(productionResult),
        shadow: confidenceProvenance(shadowResult)
      },
      confidence: {
        production: confidenceRecord(productionResult),
        shadow: confidenceRecord(shadowResult)
      },
      ...(evaluation?.groundTruth === undefined ? {} : { groundTruth: evaluation.groundTruth }),
      ...(evaluation?.evaluationOutcome === undefined ? {} : { evaluationOutcome: evaluation.evaluationOutcome })
    };
    await withDeadline(Promise.resolve(this.#store.append(record)), this.#timeoutMs, undefined);
    try {
      this.#onRecord?.(record);
    } catch {
      // Observability callbacks are isolated from production and shutdown.
    }
  }
}

export interface DecisionBenchmarkAggregate {
  shadowBackend: string;
  shadowProvider: string;
  shadowModel: string;
  operation: DecisionOperation;
  requests: number;
  successful: number;
  successRate: number;
  supported: number;
  unsupported: number;
  errors: number;
  timeouts: number;
  abstentions: number;
  lowConfidence: number;
  abstainRate: number;
  lowConfidenceRate: number;
  agreements: number;
  disagreements: number;
  agreementRate: number | null;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export function aggregateDecisionBenchmarks(records: DecisionBenchmarkRecord[]): DecisionBenchmarkAggregate[] {
  const groups = new Map<string, DecisionBenchmarkRecord[]>();
  for (const record of records) {
    const key = `${record.shadowBackend}\u0000${record.shadowProvider}\u0000${record.shadowModel}\u0000${record.operation}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((group) => {
    const comparable = group.filter((record) => record.agreement.comparable);
    const latencies = group.map((record) => record.shadowLatencyMs).sort((a, b) => a - b);
    const agreements = comparable.filter((record) => record.agreement.agreed).length;
    return {
      shadowBackend: group[0].shadowBackend,
      shadowProvider: group[0].shadowProvider,
      shadowModel: group[0].shadowModel,
      operation: group[0].operation,
      requests: group.length,
      successful: countStatus(group, "ok"),
      successRate: countStatus(group, "ok") / group.length,
      supported: group.filter((record) => record.shadowResult.status !== "unsupported").length,
      unsupported: countStatus(group, "unsupported"),
      errors: countStatus(group, "error"),
      timeouts: countStatus(group, "timeout"),
      abstentions: countStatus(group, "abstain"),
      lowConfidence: countStatus(group, "low_confidence"),
      abstainRate: countStatus(group, "abstain") / group.length,
      lowConfidenceRate: countStatus(group, "low_confidence") / group.length,
      agreements,
      disagreements: comparable.length - agreements,
      agreementRate: comparable.length ? agreements / comparable.length : null,
      averageLatencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95)
    };
  }).sort((a, b) => a.shadowBackend.localeCompare(b.shadowBackend) || String(a.operation).localeCompare(String(b.operation)));
}

export function compareDecisionResults(operation: DecisionOperation, production: DecisionResponse, shadow: DecisionResponse): DecisionAgreement {
  if (production.status === "abstain" || production.status === "low_confidence" || shadow.status === "abstain" || shadow.status === "low_confidence") {
    const agreed = production.status === shadow.status;
    return { comparable: true, agreed, score: agreed ? 1 : 0, method: "status" };
  }
  if (production.status !== "ok" || shadow.status !== "ok") return { comparable: false, method: "not_comparable" };
  if (operation === "select_one" || operation === "classify") {
    const agreed = production.results[0]?.id === shadow.results[0]?.id;
    return { comparable: true, agreed, score: agreed ? 1 : 0, method: "top_one" };
  }
  if (operation === "score") {
    const left = production.results[0]?.score;
    const right = shadow.results[0]?.score;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return { comparable: false, method: "not_comparable" };
    const score = clamp01(1 - Math.abs((left as number) - (right as number)) / Math.max(1, Math.abs(left as number), Math.abs(right as number)));
    const absoluteDifference = Math.abs((left as number) - (right as number));
    if (production.diagnostics?.decisionKind === "noul" || shadow.diagnostics?.decisionKind === "noul") {
      const sameSide = (left as number) >= 0.5 === ((right as number) >= 0.5);
      return { comparable: true, agreed: sameSide, score, method: "probability_threshold", details: { sameSide, absoluteDifference } };
    }
    return { comparable: true, agreed: score >= 0.9, score, method: "normalized_score", details: { absoluteDifference, normalizedSimilarity: score } };
  }
  if (operation === "rank") {
    const left = production.results.map(({ id }) => id);
    const right = shadow.results.map(({ id }) => id);
    const size = Math.max(left.length, right.length);
    if (!size) return { comparable: false, method: "not_comparable" };
    const overlap = left.filter((id) => right.includes(id)).length / size;
    const topOneAgreement = left[0] === right[0];
    return { comparable: true, agreed: topOneAgreement && overlap === 1, score: overlap, method: "top_k_overlap", details: { topOneAgreement, topKOverlap: overlap } };
  }
  if (operation === "extract") {
    const left = production.results[0]?.value;
    const right = shadow.results[0]?.value;
    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
      const matchingFields = keys.filter((key) => key in left && key in right && stableJson(left[key]) === stableJson(right[key])).length;
      const missingFields = keys.filter((key) => !(key in left) || !(key in right)).length;
      const score = keys.length ? matchingFields / keys.length : 1;
      return { comparable: true, agreed: score === 1, score, method: "structural", details: { matchingFields, missingFields, totalFields: keys.length } };
    }
    const agreed = stableJson(left) === stableJson(right);
    return { comparable: true, agreed, score: agreed ? 1 : 0, method: "structural" };
  }
  return { comparable: false, method: "not_comparable" };
}

export function fingerprintDecisionRequest(request: DecisionRequest): string {
  const safeShape = {
    operation: request.operation,
    candidates: (request.candidates ?? []).map(({ id }) => id),
    inputShape: valueShape(request.input),
    purpose: typeof request.metadata?.purpose === "string" ? request.metadata.purpose : undefined
  };
  return `decision:${fnv1a(stableJson(safeShape))}`;
}

function summarize(response: DecisionResponse): DecisionResultSummary {
  const valueFingerprints = response.results
    .filter((result) => result.value !== undefined)
    .map((result) => fnv1a(stableJson(result.value)));
  return {
    status: response.status,
    confidence: response.confidence,
    resultIds: response.results.map(({ id }) => id),
    scores: response.results.map(({ score }) => score ?? null),
    ...(valueFingerprints.length ? { valueFingerprints } : {})
  };
}

function confidenceProvenance(response: DecisionResponse): ConfidenceProvenance {
  const value = response.diagnostics?.confidenceSource;
  if (typeof value === "string" && value) return value;
  return response.confidence === undefined ? "unavailable" : "derived";
}

function confidenceRecord(response: DecisionResponse): DecisionConfidenceRecord {
  const source = confidenceProvenance(response);
  const kindValue = response.diagnostics?.confidenceKind;
  const kind = typeof kindValue === "string" && kindValue
    ? kindValue
    : response.confidence === undefined
      ? "absent"
      : source === "provider"
        ? "native"
        : "derived";
  return { value: response.confidence, source, kind };
}

function diagnosticIdentifier(response: DecisionResponse, key: "provider" | "providerModel"): string {
  const value = response.diagnostics?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueShape(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", length: value.length, items: [...new Set(value.map((item) => typeof item))].sort() };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).sort() };
  return { type: typeof value };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function countStatus(records: DecisionBenchmarkRecord[], status: DecisionStatus): number {
  return records.filter((record) => record.shadowResult.status === status).length;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
