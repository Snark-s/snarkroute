import {
  DECISION_PROTOCOL,
  DecisionResponseSchema,
  type DecisionAdapter,
  type DecisionAdapterContext,
  type DecisionRequest,
  type DecisionResponse,
  type ModelInfo
} from "@snarkroute/core";

export interface NeedleDecisionAdapterOptions {
  id?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  healthTimeoutMs?: number;
  resetOnClose?: boolean;
}

export interface NeedleDecisionEngineOptions {
  id?: string;
  title?: string;
  priority?: number;
  configured?: boolean;
  weightsId?: string;
}

export class NeedleDecisionAdapter implements DecisionAdapter {
  readonly id: string;
  readonly #baseUrl?: string;
  readonly #fetch: typeof fetch;
  readonly #healthTimeoutMs: number;
  readonly #resetOnClose: boolean;

  constructor(options: NeedleDecisionAdapterOptions = {}) {
    this.id = options.id ?? "needle";
    this.#baseUrl = normalizedBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#healthTimeoutMs = positiveInteger(options.healthTimeoutMs, 2_000);
    this.#resetOnClose = options.resetOnClose ?? true;
  }

  supports(_engine: ModelInfo, request: DecisionRequest): boolean {
    if (request.operation === "select_one" || request.operation === "classify") return Boolean(request.candidates?.length);
    if (request.operation === "tool_call") return toolSchemas(request).length > 0;
    return request.operation === "extract" && Boolean(extractionSchema(request));
  }

  async health(): Promise<{ available: boolean; status: string }> {
    if (!this.#baseUrl) return { available: false, status: "runtime_not_configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#healthTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/model`, { method: "GET", signal: controller.signal });
      if (!response.ok) return { available: false, status: "runtime_unavailable" };
      const payload = await response.json().catch(() => null);
      return isRecord(payload) && !payload.error
        ? { available: true, status: "available" }
        : { available: false, status: "runtime_unavailable" };
    } catch {
      return { available: false, status: "runtime_unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(request: DecisionRequest, context: DecisionAdapterContext): Promise<DecisionResponse> {
    if (!this.#baseUrl) return failure("runtime_not_configured", "Needle runtime is not configured.");
    if (!this.supports(context.engine, request)) {
      return { status: "unsupported", results: [], message: `Needle does not support this ${request.operation} request.` };
    }
    const tools = toolsForRequest(request);
    if (!tools) return { status: "unsupported", results: [], message: "Needle requires candidates or an extraction schema." };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: queryText(request.input), tools }),
        signal: context.signal
      });
    } catch {
      return failure(context.signal.aborted ? "aborted" : "runtime_unavailable", "Needle runtime request failed.");
    }
    if (!response.ok) return failure("runtime_unavailable", "Needle runtime rejected the decision request.", response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure("invalid_response", "Needle runtime returned invalid JSON.");
    }
    return validatedDecisionResponse(responseFromNeedle(payload, request, context.engine));
  }

  async close(): Promise<void> {
    if (!this.#baseUrl || !this.#resetOnClose) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#healthTimeoutMs);
    try {
      await this.#fetch(`${this.#baseUrl}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: controller.signal });
    } catch {
      // The sidecar owns its process lifecycle; shutdown remains best effort.
    } finally {
      clearTimeout(timer);
    }
  }
}

export function needleDecisionEngine(options: NeedleDecisionEngineOptions = {}): ModelInfo {
  const configured = options.configured ?? false;
  return {
    id: options.id ?? "needle-local",
    providerId: "needle",
    title: options.title ?? "Needle local runtime",
    kind: "decision",
    protocols: [DECISION_PROTOCOL],
    capabilities: ["decision.select_one", "decision.classify", "decision.extract", "decision.tool_call"],
    availability: configured ? "unknown" : "unavailable",
    priority: options.priority ?? 15,
    adapterId: "needle",
    metadata: { configured, ...(options.weightsId ? { weightsId: options.weightsId } : {}) }
  };
}

function toolsForRequest(request: DecisionRequest): Array<Record<string, unknown>> | undefined {
  if (request.operation === "select_one" || request.operation === "classify") {
    const ids = (request.candidates ?? []).map(({ id }) => id);
    if (!ids.length) return undefined;
    return [{
      name: "submit_decision",
      description: "Select exactly one candidate supported by the query.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", enum: ids } },
        required: ["id"],
        additionalProperties: false
      }
    }];
  }
  if (request.operation === "tool_call") {
    const tools = toolSchemas(request);
    return tools.length ? tools : undefined;
  }
  const schema = extractionSchema(request);
  return schema ? [{ name: "extract_record", description: "Extract the requested structured record from the query.", parameters: schema }] : undefined;
}

function responseFromNeedle(payload: unknown, request: DecisionRequest, engine: ModelInfo): DecisionResponse {
  if (!isRecord(payload) || payload.error || !Array.isArray(payload.function_calls)) {
    return failure("invalid_response", "Needle returned an invalid decision response.");
  }
  const confidence = confidenceNumber(payload.confidence);
  const diagnostics = {
    confidenceSource: confidence === undefined ? "unavailable" : "provider",
    confidenceKind: confidence === undefined ? "absent" : "calibrated",
    providerModel: typeof engine.metadata?.weightsId === "string" ? engine.metadata.weightsId : undefined,
    prefillTps: finiteNumber(payload.prefill_tps),
    decodeTps: finiteNumber(payload.decode_tps)
  };
  if (payload.function_calls.length === 0) {
    const suppressed = Array.isArray(payload.suppressed_calls) && payload.suppressed_calls.length > 0;
    return {
      status: suppressed ? "low_confidence" : "abstain",
      results: [],
      confidence,
      diagnostics: { ...diagnostics, reason: suppressed ? "suppressed_call" : "no_call" }
    };
  }
  const first = payload.function_calls[0];
  if (!isRecord(first) || typeof first.name !== "string" || !isRecord(first.arguments)) {
    return failure("invalid_response", "Needle returned an invalid function call.");
  }
  if (request.operation === "extract") {
    if (first.name !== "extract_record") return failure("invalid_response", "Needle returned an unexpected extraction tool.");
    return { status: "ok", results: [{ id: "extraction", value: first.arguments }], confidence, diagnostics };
  }
  if (request.operation === "tool_call") {
    const allowed = new Set(toolSchemas(request).map((tool) => tool.name as string));
    const results = payload.function_calls.map((call) => {
      if (!isRecord(call) || typeof call.name !== "string" || !allowed.has(call.name) || !isRecord(call.arguments)) return undefined;
      return { id: call.name, value: call.arguments };
    });
    if (results.some((result) => result === undefined)) return failure("invalid_response", "Needle returned an unknown or invalid tool call.");
    return { status: "ok", results: results as Array<{ id: string; value: Record<string, unknown> }>, confidence, diagnostics };
  }
  const id = typeof first.arguments.id === "string" ? first.arguments.id : undefined;
  const candidateIds = new Set((request.candidates ?? []).map((candidate) => candidate.id));
  if (first.name !== "submit_decision" || !id || !candidateIds.has(id)) {
    return failure("invalid_response", "Needle returned an unknown candidate.");
  }
  return { status: "ok", results: [{ id, ...(confidence === undefined ? {} : { score: confidence }) }], confidence, diagnostics };
}

function extractionSchema(request: DecisionRequest): Record<string, unknown> | undefined {
  const direct = request.metadata?.schema;
  if (isRecord(direct) && direct.type === "object") return direct;
  if (isRecord(request.input) && isRecord(request.input.schema) && request.input.schema.type === "object") return request.input.schema;
  return undefined;
}

function toolSchemas(request: DecisionRequest): Array<Record<string, unknown>> {
  const source = request.metadata?.tools ?? (isRecord(request.input) ? request.input.tools : undefined);
  if (!Array.isArray(source)) return [];
  return source.filter((tool): tool is Record<string, unknown> => isRecord(tool)
    && typeof tool.name === "string"
    && Boolean(tool.name.trim())
    && isRecord(tool.parameters)
    && tool.parameters.type === "object");
}

function queryText(input: unknown): string {
  if (typeof input === "string") return input;
  if (isRecord(input) && typeof input.query === "string") return input.query;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function failure(reason: string, message: string, httpStatus?: number): DecisionResponse {
  return { status: "error", results: [], message, diagnostics: { reason, ...(httpStatus === undefined ? {} : { httpStatus }) } };
}

function validatedDecisionResponse(response: DecisionResponse): DecisionResponse {
  const parsed = DecisionResponseSchema.safeParse(response);
  return parsed.success
    ? parsed.data as DecisionResponse
    : failure("invalid_response", "Needle response could not be normalized to decision.v1.");
}

function normalizedBaseUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
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
