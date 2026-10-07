import {
  DECISION_PROTOCOL,
  DecisionResponseSchema,
  type DecisionAdapter,
  type DecisionAdapterContext,
  type DecisionCandidate,
  type DecisionRequest,
  type DecisionResponse,
  type ModelInfo
} from "@snarkroute/core";

export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";

export interface JevDecisionAdapterOptions {
  id?: string;
  apiKey?: string;
  endpoint?: string;
  model?: string;
  fetch?: typeof fetch;
}

export interface JevDecisionEngineOptions {
  id?: string;
  title?: string;
  priority?: number;
  configured?: boolean;
  model?: string;
}

export class JevDecisionAdapter implements DecisionAdapter {
  readonly id: string;
  readonly #apiKey?: string;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(options: JevDecisionAdapterOptions = {}) {
    this.id = options.id ?? "jev";
    this.#apiKey = normalizeString(options.apiKey);
    this.#endpoint = normalizeString(options.endpoint) ?? JEV_DEFAULT_ENDPOINT;
    this.#model = normalizeString(options.model) ?? JEV_DEFAULT_MODEL;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  supports(_engine: ModelInfo, request: DecisionRequest): boolean {
    if (request.operation === "select_one" || request.operation === "classify") {
      const count = request.candidates?.length ?? 0;
      return count > 0 && count <= 255;
    }
    if (request.operation !== "score") return false;
    return isNoulRequest(request) || scoreCriteria(request).length >= 2;
  }

  async health(): Promise<{ available: boolean; status: string }> {
    return this.#apiKey
      ? { available: true, status: "configured" }
      : { available: false, status: "missing_auth" };
  }

  async execute(request: DecisionRequest, context: DecisionAdapterContext): Promise<DecisionResponse> {
    if (!this.#apiKey) return failure("missing_auth", "Jev authentication is not configured.");
    if (!this.supports(context.engine, request)) {
      return { status: "unsupported", results: [], message: `Jev does not support this ${request.operation} request.` };
    }

    const question = jevQuestion(request);
    if (!question) return { status: "unsupported", results: [], message: "Jev requires candidates or an explicit score rubric." };

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ state: request.input, model: this.#model, questions: { decision: question } }),
        signal: context.signal
      });
    } catch {
      return failure(context.signal.aborted ? "aborted" : "network_error", "Jev request failed.");
    }

    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? "authentication_rejected" : "provider_error";
      return {
        status: "error",
        results: [],
        message: "Jev rejected the decision request.",
        diagnostics: { reason, httpStatus: response.status }
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure("invalid_response", "Jev returned invalid JSON.");
    }
    return validatedDecisionResponse(responseFromJev(payload, request));
  }
}

export function jevDecisionEngine(options: JevDecisionEngineOptions = {}): ModelInfo {
  const configured = options.configured ?? false;
  return {
    id: options.id ?? "jev-main",
    providerId: "jev",
    title: options.title ?? "Jev System One",
    kind: "decision",
    protocols: [DECISION_PROTOCOL],
    capabilities: ["decision.select_one", "decision.classify", "decision.score"],
    availability: configured ? "unknown" : "unavailable",
    priority: options.priority ?? 20,
    adapterId: "jev",
    metadata: { model: options.model ?? JEV_DEFAULT_MODEL, configured }
  };
}

function jevQuestion(request: DecisionRequest): Record<string, unknown> | undefined {
  const instructions = instructionText(request);
  if (request.operation === "select_one" || request.operation === "classify") {
    return {
      type: "choice",
      instructions,
      criteria: Object.fromEntries((request.candidates ?? []).map((candidate) => [candidate.id, candidateDescription(candidate)]))
    };
  }
  if (request.operation !== "score") return undefined;
  if (isNoulRequest(request)) {
    const criteria = isRecord(request.metadata?.noulCriteria) ? request.metadata?.noulCriteria : undefined;
    return { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
  }
  const criteria = scoreCriteria(request);
  return criteria.length >= 2 ? { type: "score", instructions, criteria } : undefined;
}

function responseFromJev(payload: unknown, request: DecisionRequest): DecisionResponse {
  if (!isRecord(payload) || !isRecord(payload.answers) || !isRecord(payload.answers.decision)) {
    return failure("invalid_response", "Jev returned an invalid decision response.");
  }
  const answer = payload.answers.decision;
  const diagnostics = {
    providerModel: typeof payload.model === "string" ? payload.model : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    confidenceSource: answer.type === "noul" ? "derived_from_probability" : "provider",
    confidenceKind: answer.type === "noul" ? "derived" : "native",
    decisionKind: answer.type === "noul" ? "noul" : answer.type
  };

  if ((request.operation === "select_one" || request.operation === "classify") && answer.type === "choice") {
    const choice = normalizeString(answer.choice);
    const candidateIds = new Set((request.candidates ?? []).map(({ id }) => id));
    if (!choice || !candidateIds.has(choice)) return failure("invalid_response", "Jev returned an unknown choice.");
    const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
    const probability = finiteNumber(probabilities[choice]);
    const confidence = confidenceNumber(answer.confidence) ?? confidenceNumber(probability);
    return { status: "ok", results: [{ id: choice, ...(probability === undefined ? {} : { score: probability }) }], confidence, diagnostics };
  }

  if (request.operation === "score" && answer.type === "score") {
    const score = finiteNumber(answer.score);
    if (score === undefined) return failure("invalid_response", "Jev returned an invalid score.");
    return { status: "ok", results: [{ id: resultId(request), score }], confidence: confidenceNumber(answer.confidence), diagnostics };
  }

  if (request.operation === "score" && answer.type === "noul") {
    const score = confidenceNumber(answer.noul);
    if (score === undefined) return failure("invalid_response", "Jev returned an invalid Noul probability.");
    return { status: "ok", results: [{ id: resultId(request), score }], confidence: Math.max(score, 1 - score), diagnostics };
  }
  return failure("invalid_response", "Jev returned an answer for a different decision operation.");
}

function instructionText(request: DecisionRequest): string {
  return normalizeString(request.metadata?.instructions)
    ?? `Perform the ${request.operation} decision using only the supplied state and criteria.`;
}

function candidateDescription(candidate: DecisionCandidate): string | null {
  return normalizeString(candidate.metadata?.description)
    ?? (typeof candidate.value === "string" ? candidate.value : null)
    ?? candidate.id;
}

function scoreCriteria(request: DecisionRequest): string[] {
  const value = request.metadata?.scoreCriteria ?? request.metadata?.jevCriteria;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).slice(0, 10) : [];
}

function isNoulRequest(request: DecisionRequest): boolean {
  return request.metadata?.jevQuestionType === "noul" || request.metadata?.questionType === "noul";
}

function resultId(request: DecisionRequest): string {
  return normalizeString(request.metadata?.resultId) ?? "score";
}

function failure(reason: string, message: string): DecisionResponse {
  return { status: "error", results: [], message, diagnostics: { reason } };
}

function validatedDecisionResponse(response: DecisionResponse): DecisionResponse {
  const parsed = DecisionResponseSchema.safeParse(response);
  return parsed.success
    ? parsed.data as DecisionResponse
    : failure("invalid_response", "Jev response could not be normalized to decision.v1.");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function confidenceNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined || number < 0 || number > 1 ? undefined : number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
