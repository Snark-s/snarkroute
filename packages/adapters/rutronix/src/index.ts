import { estimateCatalogPricingQuote, ModelGateway, type ModelInfo, type ModelPricingInput, type PricingQuote, type ProviderAdapter } from "@snarkroute/core";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";
import { getRubPerUsd } from "@snarkroute/protocol";

export const RUTRONIX_BASE_URL = "https://api.rutronix.ai";
export const RUTRONIX_CHAT_PATH = "/functions/v1/chat-completions";
export const RUTRONIX_DEFAULT_MODEL = "deepseek-v4-flash";
export const RUTRONIX_MISSING_KEY_MESSAGE = "RUTRONIX_API_KEY is not configured. Add it in Settings > AI Providers > RuTronix.";

export const RUTRONIX_DOCUMENTED_MODELS = [
  "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner",
  "grok-4.3", "grok-4.2", "grok-4", "grok-4-1-fast-reasoning", "grok-4-1-fast-non-reasoning",
  "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5",
  "gpt-5.5", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex", "gpt-5.2", "gpt-5.1", "gpt-5-mini", "gpt-5-nano", "gpt-4o", "gpt-4o-mini",
  "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash",
  "sonar", "sonar-pro", "yandexgpt-5.1", "yandexgpt-5-pro", "minimax-m3", "one-perfect-answer"
] as const;

export type RuTronixModelInfo = { id: string; name?: string; pricing?: Record<string, unknown> };
export type RuTronixClientOptions = { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch; modelGateway?: Pick<ModelGateway, "invoke"> };

export function documentedRuTronixModels(): RuTronixModelInfo[] {
  return RUTRONIX_DOCUMENTED_MODELS.map((id) => ({ id, name: id }));
}

export function rutronixModelInfoToModelInfo(model: RuTronixModelInfo): ModelInfo {
  return { id: model.id, providerId: "rutronix", title: model.name ?? model.id, capabilities: ["text.generate"], inputTypes: ["text", "image"], outputTypes: ["text"], supportsImages: true, pricingHint: model.pricing ? "rutronix_manual_estimate" : undefined, metadata: { source: "rutronix_documented_models", pricing: model.pricing } };
}

export function createRuTronixClient(options: RuTronixClientOptions = {}) {
  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? process.env.RUTRONIX_BASE_URL ?? RUTRONIX_BASE_URL).replace(/\/+$/u, "");
  return {
    async chatCompletions(body: Record<string, unknown>): Promise<unknown> {
      const apiKey = options.apiKey ?? process.env.RUTRONIX_API_KEY;
      if (!apiKey?.trim()) throw new Error(RUTRONIX_MISSING_KEY_MESSAGE);
      const response = await fetcher(`${baseUrl}${RUTRONIX_CHAT_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`RuTronix request failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`);
      }
      return response.json();
    },
    async getModels(): Promise<RuTronixModelInfo[]> {
      // RuTronix does not currently document a models endpoint. Keep availability fail-open
      // from the provider's published model list rather than guessing an API URL.
      return documentedRuTronixModels();
    }
  };
}

export function createRuTronixTextNodeRunner(options: RuTronixClientOptions = {}): NodeRunner {
  const gateway = options.modelGateway;
  return async ({ node, params, inputs }) => {
    const model = stringValue(params.model) || RUTRONIX_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? stringValue(params.prompt) ?? "";
    if (!prompt.trim()) throw new Error("RuTronix Text requires a prompt.");
    const systemPrompt = firstInputText(inputs.systemPrompt) ?? stringValue(params.systemPrompt);
    const invoked = gateway ? await gateway.invoke({ capability: "text.generate", modelRef: `model://rutronix/${model}`, input: { prompt, systemPrompt }, parameters: params, metadata: { nodeId: node.id, nodeType: node.type } }) : null;
    const response = invoked?.output.output ?? await createRuTronixClient(options).chatCompletions({ model, messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: prompt }], stream: false, temperature: params.temperature, max_completion_tokens: params.max_completion_tokens ?? params.max_tokens });
    const text = invoked && typeof invoked.output.text === "string" ? invoked.output.text : firstChatText(response);
    if (!text) throw new Error(`RuTronix model "${model}" did not return text.`);
    const usage = objectField(response, "usage");
    const quote = estimateRuTronixPricingQuote({ provider: "rutronix", providerModel: model, capability: "text.generate", params, inputMetadata: {} });
    const providerCost = normalizeRuTronixProviderCostFromUsage(usage, { responseCurrency: objectField(response, "currency") ?? objectField(response, "cost_currency") });
    return {
      output: { text, output: response, provider: "rutronix", model, providerModel: model, estimatedCost: quote.estimatedCost, estimatedCostCurrency: quote.currency, actualUsage: usage, actualCost: providerCost?.amountUsd ?? null, actualCostCurrency: providerCost?.currency ?? null, pricingSource: quote.pricingSource, pricingQuote: quote, status: "succeeded" },
      logs: [`Generated text with RuTronix ${model}`, ...(providerCost?.currency === "unknown" ? ["RuTronix RUB cost could not be converted; using route estimate for credit capture."] : [])],
      provenance: { provider: "rutronix", model },
      providerUsage: usageEvent(node.id, node.type, model, usage, quote, providerCost)
    };
  };
}

export function createRuTronixProviderAdapter(options: RuTronixClientOptions = {}): ProviderAdapter {
  const client = createRuTronixClient(options);
  return { id: "rutronix", title: "RuTronix", capabilities: ["text.generate"], pricingResolver: { estimate: estimateRuTronixPricingQuote }, async invoke(request) {
    if (request.capability !== "text.generate") throw new Error(`RuTronix adapter does not support capability "${request.capability}".`);
    const prompt = stringValue(request.input.prompt) ?? "";
    const systemPrompt = stringValue(request.input.systemPrompt);
    const response = await client.chatCompletions({ model: request.model.id, messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: prompt }], stream: false, ...(request.parameters ?? {}) });
    return { modelId: request.model.id, providerId: "rutronix", capability: request.capability, output: { text: firstChatText(response), output: response, model: request.model.id }, usage: objectRecord(objectField(response, "usage")), raw: response };
  } };
}

export function estimateRuTronixPricingQuote(input: ModelPricingInput): PricingQuote {
  return estimateCatalogPricingQuote(input, input.params.pricing, "rutronix_manual_estimate");
}

export type NormalizedRuTronixProviderCost = { amountUsd: number; currency: "USD"; sourceCurrency: "USD" | "RUB" } | { amountUsd: null; currency: "unknown"; sourceCurrency: "RUB" | "unknown" };
export function normalizeRuTronixProviderCostFromUsage(usage: unknown, options: { responseCurrency?: unknown } = {}): NormalizedRuTronixProviderCost | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const rub = numberValue(record.cost_rub ?? record.amount_rub);
  const cost = numberValue(record.cost ?? record.amount);
  const currency = stringValue(record.currency ?? record.cost_currency ?? options.responseCurrency)?.toUpperCase();
  if (rub !== undefined) return amountUsdFromRub(rub);
  if (cost !== undefined && currency === "RUB") return amountUsdFromRub(cost);
  if (cost !== undefined && currency === "USD") return { amountUsd: cost, currency: "USD", sourceCurrency: "USD" };
  if (cost !== undefined) return { amountUsd: null, currency: "unknown", sourceCurrency: "unknown" };
  return null;
}

function amountUsdFromRub(amountRub: number): NormalizedRuTronixProviderCost {
  const rate = getRubPerUsd();
  return rate ? { amountUsd: amountRub / rate, currency: "USD", sourceCurrency: "RUB" } : { amountUsd: null, currency: "unknown", sourceCurrency: "RUB" };
}
function usageEvent(nodeId: string, nodeType: string, model: string, usage: unknown, quote: PricingQuote, cost: NormalizedRuTronixProviderCost | null): ProviderUsageEvent { return { provider: "rutronix", model, providerModel: model, nodeId, nodeType, status: "succeeded", metrics: objectRecord(usage), estimatedCost: quote.estimatedCost, actualCost: cost?.amountUsd ?? null, actualCostCurrency: cost?.currency ?? null, pricingHint: quote.pricingSource, pricingSource: quote.pricingSource, pricingQuote: quote }; }
function firstChatText(value: unknown): string | undefined { const choices = objectField(value, "choices"); if (!Array.isArray(choices)) return undefined; const message = objectField(choices[0], "message"); const content = objectField(message, "content"); return typeof content === "string" ? content : undefined; }
function firstInputText(value: unknown): string | undefined { if (typeof value === "string") return value; if (!value || typeof value !== "object") return undefined; for (const entry of Object.values(value as Record<string, unknown>)) { if (typeof entry === "string") return entry; if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") return String((entry as Record<string, unknown>).text); } return undefined; }
function objectField(value: unknown, key: string): unknown { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
function objectRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function numberValue(value: unknown): number | undefined { const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined; }
