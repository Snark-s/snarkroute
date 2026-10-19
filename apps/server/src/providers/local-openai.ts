import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";
import { localServiceUrl, assertLocalInferenceEndpoint } from "../services/local-service-endpoints";
import { normalizeProviderModelToV1Input, type ProviderModelInfoV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { ModelRoutingPolicyError } from "../services/model-routing-policy";
import { providerHttpError } from "@snarkroute/executor";
import { redactSecrets } from "../services/errors";

export const LOCAL_OPENAI_PROVIDER_ID = "local_openai";
export const BONSAI_CANONICAL_MODEL_ID = "bonsai-2-27b";
export const DEFAULT_LOCAL_LLM_BASE_URL = localServiceUrl("bonsai_inference", "/v1");
export const DEFAULT_BONSAI_PROVIDER_MODEL_ID = "Ternary-Bonsai-2-27B-PQ2_0.gguf";
export const DEFAULT_LOCAL_LLM_TIMEOUT_MS = 600_000;
export const DEFAULT_LOCAL_LLM_MAX_CONCURRENCY = 1;
const LOCAL_LLM_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_LOCAL_LLM_TIMEOUT_MS = 3_600_000;
const MAX_LOCAL_LLM_CONCURRENCY = 8;

type FetchLike = typeof fetch;

export type LocalOpenAiConfig = {
  baseUrl: string;
  apiKey?: string;
  fallbackModelId: string;
  timeoutMs: number;
  maxConcurrency: number;
  /** Additional endpoints are opt-in and expose only these physical model IDs. */
  modelIds?: string[];
  reasoningEffort?: "none" | "low" | "medium" | "high";
  /** Explicit per-model confirmation for AtomicAgentRuntime auto protocol selection. */
  nativeToolModelIds?: string[];
  /** Do not expose offline placeholders for automatically discovered optional runtimes. */
  optionalDiscovery?: boolean;
};

function validatedLocalUrl(raw: string): string {
  const url = normalizeBaseUrl(raw);
  assertLocalInferenceEndpoint(url);
  return url;
}

export function localOpenAiConfig(env: NodeJS.ProcessEnv = process.env): LocalOpenAiConfig {
  return {
    baseUrl: validatedLocalUrl(env.LOCAL_LLM_BASE_URL || DEFAULT_LOCAL_LLM_BASE_URL),
    apiKey: env.LOCAL_LLM_API_KEY?.trim() || undefined,
    fallbackModelId: env.LOCAL_LLM_MODEL_ID?.trim() || DEFAULT_BONSAI_PROVIDER_MODEL_ID,
    timeoutMs: positiveTimeout(env.LOCAL_LLM_TIMEOUT_MS, DEFAULT_LOCAL_LLM_TIMEOUT_MS),
    maxConcurrency: positiveConcurrency(env.LOCAL_LLM_MAX_CONCURRENCY, DEFAULT_LOCAL_LLM_MAX_CONCURRENCY)
  };
}

/** Official Ollama model tags. Exposed only after local model discovery confirms installation. */
export const BONSAI2_OLLAMA_MODEL_IDS = ["bonsai-2:2b", "bonsai-2:4b", "bonsai-2:9b", "bonsai-2:27b"] as const;

export function localOpenAiConfigs(env: NodeJS.ProcessEnv = process.env): LocalOpenAiConfig[] {
  const primary = localOpenAiConfig(env);
  const rawEntries: unknown = env.LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON?.trim()
    ? JSON.parse(env.LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON)
    : [];
  if (!Array.isArray(rawEntries) || rawEntries.length > 4) throw new Error("Invalid additional local endpoints.");
  const ids = new Set<string>();
  const urls = new Set([primary.baseUrl]);
  const additional: LocalOpenAiConfig[] = rawEntries.map(entry => {
    const value = objectRecord(entry);
    const baseUrl = validatedLocalUrl(stringValue(value.baseUrl) ?? "");
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || urls.has(baseUrl)) {
      throw new Error("Additional local endpoints must be distinct loopback HTTP URLs.");
    }
    urls.add(baseUrl);
    if (!Array.isArray(value.modelIds) || !value.modelIds.length) throw new Error("Additional local endpoint requires explicit modelIds.");
    const modelIds = value.modelIds.map(id => {
      if (typeof id !== "string" || !id.trim() || /cloud/i.test(id) || ids.has(id)) throw new Error("Invalid, cloud or duplicate additional local model ID.");
      ids.add(id);
      return id;
    });
    const reasoningEffort = value.reasoningEffort;
    const nativeToolModelIds = value.nativeToolModelIds;
    if (nativeToolModelIds !== undefined && (!Array.isArray(nativeToolModelIds) || nativeToolModelIds.some(id => !modelIds.includes(id)))) throw new Error("Native tools confirmation must reference an allowlisted local model.");
    if (reasoningEffort !== undefined && !["none", "low", "medium", "high"].includes(String(reasoningEffort))) throw new Error("Invalid local reasoning effort.");
    return { ...primary, baseUrl, apiKey: undefined, fallbackModelId: modelIds[0], modelIds,
      reasoningEffort: reasoningEffort as LocalOpenAiConfig["reasoningEffort"], nativeToolModelIds: nativeToolModelIds as string[] | undefined };
  });
  const ollamaUrl = localServiceUrl("ollama_inference", "/v1");
  // Experimental only: upstream Q2_0 decoding may omit PrismML's Hadamard transforms.
  // Never automatically offer potentially invalid agent outputs on stock Ollama.
  if (env.BONSAI2_OLLAMA_EXPERIMENTAL === "1" && primary.baseUrl !== ollamaUrl) {
    const alreadyConfigured = additional.find(config => config.baseUrl === ollamaUrl);
    if (alreadyConfigured) {
      alreadyConfigured.modelIds = [...new Set([...(alreadyConfigured.modelIds ?? []), ...BONSAI2_OLLAMA_MODEL_IDS])];
    } else if (additional.length < 4) {
      additional.push({
        ...primary, baseUrl: ollamaUrl, apiKey: undefined,
        fallbackModelId: BONSAI2_OLLAMA_MODEL_IDS[0],
        modelIds: [...BONSAI2_OLLAMA_MODEL_IDS],
        optionalDiscovery: true
      });
    }
  }
  return [primary, ...additional];
}

export async function discoverLocalOpenAiModels(options: {
  config?: LocalOpenAiConfig;
  fetchImpl?: FetchLike;
} = {}): Promise<ProviderModelInfoV1[]> {
  if (!options.config) {
    try {
      const groups = await Promise.all(localOpenAiConfigs().map(config => discoverLocalOpenAiModels({ ...options, config })));
      return groups.flat();
    } catch (error) {
      // Invalid configuration must not take down the catalog or unrelated routes.
      return [localModel(process.env.LOCAL_LLM_MODEL_ID?.trim() || DEFAULT_BONSAI_PROVIDER_MODEL_ID,
        { baseUrl: DEFAULT_LOCAL_LLM_BASE_URL, fallbackModelId: DEFAULT_BONSAI_PROVIDER_MODEL_ID,
          timeoutMs: DEFAULT_LOCAL_LLM_TIMEOUT_MS, maxConcurrency: 1 }, false, new Date().toISOString(), safeErrorMessage(error))];
    }
  }
  const config = options.config ?? localOpenAiConfig();
  const fetchedAt = new Date().toISOString();
  const configurationError = localOpenAiConfigurationError(config);
  if (configurationError) return [localModel(config.fallbackModelId, config, false, fetchedAt, configurationError)];
  try {
    const ids = await verifiedLocalModelIds(config, options.fetchImpl ?? fetch);
    if (!ids.length) throw new Error("GET /models returned no model ids");
    return ids.map((id) => localModel(id, config, true, fetchedAt));
  } catch (error) {
    if (config.optionalDiscovery) return [];
    return (config.modelIds ?? [config.fallbackModelId]).map(id => localModel(id, config, false, fetchedAt, safeErrorMessage(error)));
  }
}

export function createLocalOpenAiTextNodeRunner(options: {
  config?: LocalOpenAiConfig;
  fetchImpl?: FetchLike;
} = {}): NodeRunner {
  if (!options.config) {
    return input => {
      const configs = localOpenAiConfigs();
      const runners = configs.map(config => createLocalOpenAiTextNodeRunner({ ...options, config }));
      const model = stringValue(input.params.providerModelId) ?? stringValue(input.params.model);
      const index = configs.findIndex(config => config.modelIds?.includes(model ?? ""));
      return runners[index < 0 ? 0 : index](input);
    };
  }
  const config = options.config ?? localOpenAiConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const gate = localInferenceGate(config.baseUrl, config.maxConcurrency);
  return async ({ node, params, inputs, context }) => {
    const configurationError = localOpenAiConfigurationError(config);
    if (configurationError) throw new Error(configurationError);
    const model = stringValue(params.providerModelId) ?? stringValue(params.model) ?? config.fallbackModelId;
    const messages = chatMessages(params.messages, inputs, params);
    if (!messages.length) throw new Error("Local OpenAI-compatible text generation requires messages or a prompt.");
    const body: Record<string, unknown> = { model, messages };
    // Bonsai 2 2B/4B/9B may spend thousands of tokens thinking, then hit the
    // llama.cpp PEG parser when short requests truncate the unfinished turn.
    // Use PrismML's documented non-thinking sampler defaults for local agents.
    // A route may explicitly opt back into thinking with enable_thinking=true.
    const smallBonsai = /bonsai[-_]?2[-_:]?(2|4|9)b(?:[-_.]|$)/i.test(model);
    if (smallBonsai) {
      const thinking = params.enable_thinking === true;
      body.chat_template_kwargs = { enable_thinking: thinking };
      body.temperature = thinking ? 1.0 : 0.7;
      body.top_p = thinking ? 0.95 : 0.8;
      body.top_k = 20;
      body.min_p = 0.0;
      body.presence_penalty = thinking ? 1.0 : 1.5;
      body.repeat_penalty = 1.0;
      body.repeat_last_n = 64;
    }
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
    copyParam(params, body, "temperature");
    copyParam(params, body, "top_p");
    copyParam(params, body, "max_tokens");
    copyParam(params, body, "max_completion_tokens");
    copyParam(params, body, "response_format");
    copyParam(params, body, "tools");
    copyParam(params, body, "tool_choice");
    const requestId = context.runId || node.id;
    const startedAt = Date.now();
    const promptChars = approximatePromptChars(messages);
    let release: (() => void) | undefined;
    let outcome: "finished" | "aborted" | "failed" = "failed";
    const acquisition = gate.acquire(context.signal);
    logLocalInference("queued", { requestId, stepId: node.id, promptChars, ...gate.snapshot() });
    try {
      release = await acquisition;
      throwIfAborted(context.signal);
      const verifiedIds = await verifiedLocalModelIds(config, fetchImpl, context.signal);
      if (!verifiedIds.includes(model)) throw new ModelRoutingPolicyError("LOCAL_MODEL_UNAVAILABLE", `Local inference service does not expose the requested model "${model}".`, LOCAL_OPENAI_PROVIDER_ID);
      const { assertLocalRuntimeAdmission } = await import("../services/local-runtime-supervisor");
      await assertLocalRuntimeAdmission(config.baseUrl === localServiceUrl("ollama_inference", "/v1") ? "ollama" : "bonsai", model);
      throwIfAborted(context.signal);
      logLocalInference("started", { requestId, stepId: node.id, promptChars, ...gate.snapshot() });
      const { response, text: responseText } = await fetchTextWithTimeout(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: requestHeaders(config),
        body: JSON.stringify(body),
        redirect: "error",
        signal: context.signal
      }, config.timeoutMs, fetchImpl);
      if (!response.ok) throw providerHttpError(response.status, LOCAL_OPENAI_PROVIDER_ID, `Local OpenAI-compatible chat failed with HTTP ${response.status}: ${responseText.slice(0, 1_000)}`);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        throw new Error("Local OpenAI-compatible chat returned invalid JSON.");
      }
      const message = firstChoiceMessage(payload);
      const text = messageContent(message);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!text && !toolCalls.length) throw new Error(`Local model "${model}" returned neither text nor tool_calls.`);
      const usage = objectRecord(payload.usage);
      const providerUsage: ProviderUsageEvent = {
        provider: LOCAL_OPENAI_PROVIDER_ID,
        model,
        providerModel: model,
        logicalModel: stringValue(params.model),
        nodeId: node.id,
        nodeType: node.type,
        status: "succeeded",
        metrics: usage,
        estimatedCost: 0,
        actualCost: 0,
        actualCostCurrency: "USD",
        pricingHint: "local_no_external_api_cost",
        pricingSource: "local",
        providerCostMicrousd: 0,
        baseCredits: 0,
        markupCredits: 0,
        finalCredits: 0,
        pricingConfidence: "high"
      };
      outcome = "finished";
      return {
        output: {
          text,
          output: payload,
          tool_calls: toolCalls,
          assistant_message: message,
          provider: LOCAL_OPENAI_PROVIDER_ID,
          logicalModel: stringValue(params.model),
          model,
          providerModel: model,
          estimatedCost: 0,
          estimatedCostCurrency: "USD",
          estimatedCostConfidence: "high",
          actualUsage: usage,
          actualCost: 0,
          actualCostCurrency: "USD",
          pricingSource: "local",
          status: "succeeded"
        },
        logs: [`Generated text with local OpenAI-compatible model ${model}`],
        metrics: { localOpenAi: { requestId, promptChars, durationMs: Date.now() - startedAt } },
        provenance: { provider: LOCAL_OPENAI_PROVIDER_ID, model, baseUrl: config.baseUrl, local: true },
        providerUsage
      };
    } catch (error) {
      if (context.signal?.aborted || isAbortError(error)) outcome = "aborted";
      throw error;
    } finally {
      release?.();
      logLocalInference(outcome, {
        requestId,
        stepId: node.id,
        promptChars,
        durationMs: Date.now() - startedAt,
        ...gate.snapshot()
      });
    }
  };
}

export function localOpenAiRuntimeSnapshot(baseUrl = localOpenAiConfig().baseUrl): {
  active: number;
  queued: number;
  concurrency: number;
} {
  return localInferenceGate(normalizeBaseUrl(baseUrl), DEFAULT_LOCAL_LLM_MAX_CONCURRENCY).snapshot();
}

function localModel(id: string, config: LocalOpenAiConfig, available: boolean, refreshedAt: string, reason?: string): ProviderModelInfoV1 {
  const bonsaiSize = /(?:^|[-_])(?:ternary[-_]?)?bonsai[-_]?2[-_:]?(2b|4b|9b|27b)(?:[-_.]|$)/i.exec(id)?.[1]?.toLowerCase();
  const bonsai = Boolean(bonsaiSize) || isBonsai2Model(id);
  return normalizeProviderModelToV1Input({
    provider: LOCAL_OPENAI_PROVIDER_ID,
    providerModelId: id,
    canonicalModelId: bonsaiSize ? `bonsai-2-${bonsaiSize}` : bonsai ? BONSAI_CANONICAL_MODEL_ID : undefined,
    displayName: bonsaiSize ? `Bonsai 2 ${bonsaiSize.toUpperCase()}` : bonsai ? "Bonsai 2 27B" : id,
    originVendor: bonsai ? "prismml" : "local",
    inputTypes: ["text"],
    outputTypes: ["text", "json"],
    capabilities: ["text.generate", "json.generate"],
    roles: ["generator"],
    availability: {
      status: available ? "available" : "unavailable",
      source: "live",
      configured: true,
      refreshedAt,
      reason: available ? undefined : `Local OpenAI-compatible endpoint ${config.baseUrl} is unavailable: ${reason ?? "unknown error"}`
    },
    pricing: {
      status: "fresh",
      source: "manual",
      currency: "USD",
      unit: "request",
      pricing: { request: 0, prompt: 0, completion: 0 },
      refreshedAt,
      warning: "Local inference has no external API charge."
    },
    metadata: {
      local: true,
      apiCost: 0,
      ...(bonsai ? { supportsTools: true, supportsReasoning: true } : {}),
      autoEligible: available,
      benchmarkRequired: true,
      baseUrl: config.baseUrl,
      discovered: available,
      ...(bonsai ? {
        upstreamModel: "prism-ml/Ternary-Bonsai-2-27B-gguf",
        preferredQuantization: "PQ2_0",
        requiresJinjaToolTemplate: true
      } : {})
    }
  });
}

async function verifiedLocalModelIds(config: LocalOpenAiConfig, fetchImpl: FetchLike, signal?: AbortSignal): Promise<string[]> {
  const endpoint = new URL(config.baseUrl);
  if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ModelRoutingPolicyError("LOCAL_SERVICE_MISMATCH", "Local inference requires an explicit loopback HTTP endpoint.", LOCAL_OPENAI_PROVIDER_ID);
  }
  const timeoutMs = Math.min(config.timeoutMs, LOCAL_LLM_DISCOVERY_TIMEOUT_MS);
  // Ollama identifies its implementation and API version independently of the
  // OpenAI compatibility list. Never POST to another service on its port.
  if (config.baseUrl === localServiceUrl("ollama_inference", "/v1")) {
    const { response, text } = await fetchTextWithTimeout(`${endpoint.origin}/api/version`, {
      method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal
    }, timeoutMs, fetchImpl);
    let version: unknown;
    try { version = JSON.parse(text); } catch { /* handled below */ }
    if (response.status !== 200 || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(recordString(version, "version") ?? "")) {
      throw new ModelRoutingPolicyError("LOCAL_SERVICE_MISMATCH", `Expected Ollama /api/version response, received HTTP ${response.status}.`, LOCAL_OPENAI_PROVIDER_ID);
    }
  }
  const { response, text } = await fetchTextWithTimeout(`${config.baseUrl}/models`, {
    method: "GET", headers: requestHeaders(config), redirect: "error", signal
  }, timeoutMs, fetchImpl);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { /* handled below */ }
  const list = objectRecord(payload);
  if (response.status !== 200 || list.object !== "list" || !Array.isArray(list.data)
    || list.service !== undefined || list.data.some(model => recordString(model, "object") !== "model" || !recordString(model, "id"))) {
    throw new ModelRoutingPolicyError("LOCAL_SERVICE_MISMATCH", `Expected OpenAI-compatible /v1/models identity and API contract, received HTTP ${response.status}.`, LOCAL_OPENAI_PROVIDER_ID);
  }
  return [...new Set(list.data.flatMap(model => {
    const id = recordString(model, "id");
    return id && !/cloud/i.test(id) && (!config.modelIds || config.modelIds.includes(id)) ? [id] : [];
  }))];
}

function chatMessages(value: unknown, inputs: Record<string, unknown>, params: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    const messages = value.filter((message): message is Record<string, unknown> => Boolean(message && typeof message === "object" && !Array.isArray(message)));
    if (messages.length) {
      const systemMessages = messages.filter((message) => stringValue(message.role)?.toLowerCase() === "system");
      if (!systemMessages.length || systemMessages.length === 1 && messages[0] === systemMessages[0]) return ensureUserMessage(messages);
      const systemContent = systemMessages
        .map((message) => messageTextContent(message.content))
        .filter((content): content is string => Boolean(content))
        .join("\n\n");
      return ensureUserMessage([
        { ...systemMessages[0], role: "system", content: systemContent || systemMessages[0].content },
        ...messages.filter((message) => stringValue(message.role)?.toLowerCase() !== "system")
      ]);
    }
  }
  const prompt = firstText(inputs.prompt) ?? stringValue(params.prompt);
  const systemPrompt = firstText(inputs.systemPrompt) ?? stringValue(params.systemPrompt);
  return ensureUserMessage([
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...(prompt ? [{ role: "user", content: prompt }] : [])
  ]);
}

function ensureUserMessage(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const roles = messages.map((message) => stringValue(message.role)?.toLowerCase());
  if (roles.includes("user") || !roles.includes("system")) return messages;
  return [...messages, { role: "user", content: "Respond to the system instructions above." }];
}

function messageTextContent(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((part) => {
    if (typeof part === "string") {
      const content = stringValue(part);
      return content ? [content] : [];
    }
    const content = recordString(part, "text");
    return content ? [content] : [];
  }).join("\n");
  return stringValue(text);
}

function firstChoiceMessage(payload: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return objectRecord(objectRecord(choices[0]).message) ?? {};
}

function messageContent(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((part) => {
    const record = objectRecord(part);
    return typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchLike
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(abortError(`Local OpenAI request timed out after ${timeoutMs} ms.`)), timeoutMs);
  const externalSignal = init.signal;
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(controller.signal);
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

type GateWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

class LocalInferenceGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];

  constructor(readonly concurrency: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: GateWaiter = { resolve, reject, signal };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  snapshot(): { active: number; queued: number; concurrency: number } {
    return { active: this.active, queued: this.waiters.length, concurrency: this.concurrency };
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.startNext();
    };
  }

  private startNext(): void {
    while (this.active < this.concurrency && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active++;
      waiter.resolve(this.releaseOnce());
    }
  }
}

const localInferenceGates = new Map<string, LocalInferenceGate>();

function localInferenceGate(baseUrl: string, concurrency: number): LocalInferenceGate {
  const key = normalizeBaseUrl(baseUrl);
  const current = localInferenceGates.get(key);
  if (current) return current;
  const created = new LocalInferenceGate(concurrency);
  localInferenceGates.set(key, created);
  return created;
}

function logLocalInference(event: "queued" | "started" | "finished" | "aborted" | "failed", details: Record<string, unknown>): void {
  console.info("[local-openai]", { event, ...details });
}

function approximatePromptChars(messages: Array<Record<string, unknown>>): number {
  return messages.reduce((total, message) => total + (messageTextContent(message.content)?.length ?? 0), 0);
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return abortError(typeof signal?.reason === "string" ? signal.reason : "The operation was aborted.");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requestHeaders(config: LocalOpenAiConfig): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
  };
}

function localOpenAiConfigurationError(config: LocalOpenAiConfig): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    return "LOCAL_LLM_BASE_URL is not a valid URL.";
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1" || parsed.hostname.endsWith(".localhost");
  if (!local && !config.apiKey) return "LOCAL_LLM_API_KEY is required when LOCAL_LLM_BASE_URL is not localhost.";
  return undefined;
}

function isBonsai2Model(id: string): boolean {
  return /(?:^|[\/_-])(?:ternary-)?bonsai-?2(?:[\/_-])?27b(?:[\/_\-.]|$)/i.test(id);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function positiveTimeout(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, MAX_LOCAL_LLM_TIMEOUT_MS) : fallback;
}

function positiveConcurrency(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, MAX_LOCAL_LLM_CONCURRENCY) : fallback;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.name === "AbortError" ? "request timed out" : redactSecrets(error.message).slice(0, 500);
  return redactSecrets(String(error)).slice(0, 500);
}

function recordString(value: unknown, key: string): string | undefined {
  return stringValue(objectRecord(value)[key]);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
  return undefined;
}

function copyParam(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (source[key] !== undefined) target[key] = source[key];
}
