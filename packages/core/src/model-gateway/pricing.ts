export type PricingCurrency = "USD" | "RUB" | (string & {});

export type PricingUnit =
  | "request"
  | "image"
  | "input_token"
  | "output_token"
  | "input_megapixel"
  | "output_megapixel"
  | "second"
  | "unknown";

export type PricingConfidence = "exact" | "estimated" | "low" | "unknown";

export interface PricingQuote {
  logicalModel?: string;
  provider: string;
  providerModel: string;
  capability: string;
  estimatedCost: number | null;
  currency: string | null;
  pricingSource: string;
  confidence: PricingConfidence;
  unit?: PricingUnit;
  breakdown?: Record<string, unknown>;
  warnings?: string[];
}

export interface ModelPricingInput {
  logicalModel?: string;
  provider: string;
  providerModel: string;
  capability: string;
  params: Record<string, unknown>;
  inputMetadata?: Record<string, unknown>;
}

export interface PricingResolver {
  estimate(input: ModelPricingInput): PricingQuote;
}

export function unknownPricingQuote(input: ModelPricingInput, pricingSource = "unknown", warning?: string): PricingQuote {
  return sanitizePricingQuote({
    logicalModel: input.logicalModel,
    provider: input.provider,
    providerModel: input.providerModel,
    capability: input.capability,
    estimatedCost: null,
    currency: null,
    pricingSource,
    confidence: "unknown",
    unit: "unknown",
    warnings: warning ? [warning] : undefined
  });
}

export function estimateCatalogPricingQuote(input: ModelPricingInput, pricing: unknown, pricingSource: string): PricingQuote {
  if (!pricing || typeof pricing !== "object") {
    return unknownPricingQuote(input, pricingSource, "No pricing metadata is available for this model.");
  }
  const pricingRecord = pricing as Record<string, unknown>;
  const currency = stringValue(pricingRecord.currency) ?? "USD";
  if (/image/i.test(input.capability)) {
    const imagePrice = numberValue(pricingRecord.image);
    if (imagePrice !== undefined) return pricedQuote(input, imagePrice, countFromParams(input.params), currency, pricingSource, "image");
    const requestPrice = numberValue(pricingRecord.request);
    if (requestPrice !== undefined) return pricedQuote(input, requestPrice, countFromParams(input.params), currency, pricingSource, "request");
    return unknownPricingQuote(input, pricingSource, "Catalog pricing does not include image or request pricing for this model.");
  }

  const tokenEstimate = tokenEstimateFromInput(input);
  const inputPrice = numberValue(pricingRecord.prompt) ?? numberValue(pricingRecord.input);
  const outputPrice = numberValue(pricingRecord.completion) ?? numberValue(pricingRecord.output);
  if ((inputPrice !== undefined || outputPrice !== undefined) && tokenEstimate) {
    const inputCost = tokenEstimate.inputTokens * (inputPrice ?? 0);
    const outputCost = tokenEstimate.outputTokens * (outputPrice ?? 0);
    return sanitizePricingQuote({
      logicalModel: input.logicalModel,
      provider: input.provider,
      providerModel: input.providerModel,
      capability: input.capability,
      estimatedCost: roundCost(inputCost + outputCost),
      currency,
      pricingSource,
      confidence: "estimated",
      unit: inputPrice !== undefined ? "input_token" : "output_token",
      breakdown: {
        inputTokens: tokenEstimate.inputTokens,
        outputTokens: tokenEstimate.outputTokens,
        inputTokenPrice: inputPrice ?? null,
        outputTokenPrice: outputPrice ?? null
      }
    });
  }

  const requestPrice = numberValue(pricingRecord.request);
  if (requestPrice !== undefined) return pricedQuote(input, requestPrice, countFromParams(input.params), currency, pricingSource, "request");
  return unknownPricingQuote(input, pricingSource, "Catalog pricing cannot be estimated before execution for this request.");
}

export function sanitizePricingQuote(quote: PricingQuote): PricingQuote {
  return stripSecretKeys(quote) as PricingQuote;
}

function pricedQuote(input: ModelPricingInput, price: number, count: number, currency: string, pricingSource: string, unit: PricingUnit): PricingQuote {
  return sanitizePricingQuote({
    logicalModel: input.logicalModel,
    provider: input.provider,
    providerModel: input.providerModel,
    capability: input.capability,
    estimatedCost: roundCost(price * count),
    currency,
    pricingSource,
    confidence: "exact",
    unit,
    breakdown: { price, count }
  });
}

function countFromParams(params: Record<string, unknown>): number {
  return Math.max(1, Math.floor(numberValue(params.n) ?? numberValue(params.count) ?? numberValue(params.requestCount) ?? 1));
}

function tokenEstimateFromInput(input: ModelPricingInput): { inputTokens: number; outputTokens: number } | null {
  const source = { ...(input.inputMetadata ?? {}), ...input.params };
  const inputTokens = numberValue(source.inputTokens) ?? numberValue(source.promptTokens) ?? numberValue(source.prompt_tokens);
  const outputTokens = numberValue(source.outputTokens) ?? numberValue(source.completionTokens) ?? numberValue(source.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

function stripSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/api[_-]?key|token|secret|password|baseUrl/i.test(key))
      .map(([key, entry]) => [key, stripSecretKeys(entry)])
  );
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
