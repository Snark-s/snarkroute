import type { NodeRunner } from "@snarkroute/executor";

const baseUrl = "https://api.experientiallabs.ai/v1";
type ClientOptions = { apiKey?: string; fetchImpl?: typeof fetch };
export function experientialConfigured(): boolean { return Boolean(process.env.EXPLABS_API_KEY?.trim()); }

export function createExperientialClient(options: ClientOptions = {}) {
  async function request(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    const key = (options.apiKey ?? process.env.EXPLABS_API_KEY)?.trim();
    if (!key) throw new Error("EXPLABS_API_KEY is not configured. Add it in Settings > AI Providers > Experiential Labs.");
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(body ? 120_000 : 5_000)
    });
    // Do not expose upstream response bodies: they may echo credentials or prompts.
    if (!response.ok) throw new Error(`Experiential Labs request failed (${response.status}).${response.status === 401 ? " Check your API key." : ""}`);
    return response.json();
  }
  return {
    async getModels(): Promise<Array<{ id: string }>> {
      const result = await request("/models");
      if (!Array.isArray(result.data)) throw new Error("Experiential Labs returned an invalid model catalog.");
      return result.data.filter((model: unknown): model is { id: string } => Boolean(model && typeof model === "object" && typeof (model as { id?: unknown }).id === "string"));
    },
    chatCompletions: (body: Record<string, unknown>, signal?: AbortSignal) => request("/chat/completions", body, signal)
  };
}

export function createExperientialTextNodeRunner(options: ClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const model = text(params.model);
    const prompt = inputText(inputs.prompt) ?? text(params.prompt);
    const systemPrompt = inputText(inputs.systemPrompt) ?? text(params.systemPrompt);
    if (!model || !prompt) throw new Error("Experiential Labs requires a model slug and a prompt.");
    const response = await createExperientialClient(options).chatCompletions({
      model, stream: false,
      messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: prompt }],
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof (params.max_tokens ?? params.max_completion_tokens) === "number" ? { max_tokens: params.max_tokens ?? params.max_completion_tokens } : {})
    }, context.signal);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content) throw new Error("Experiential Labs returned no text.");
    return {
      output: { text: content, output: response, provider: "experiential", model, providerModel: model, actualUsage: response.usage, actualCost: null, estimatedCost: null, status: "succeeded" },
      provenance: { provider: "experiential", model },
      logs: [`Generated text with Experiential Labs ${model}`],
      providerUsage: { provider: "experiential", model, providerModel: model, nodeId: node.id, nodeType: node.type, status: "succeeded", metrics: response.usage, estimatedCost: null, actualCost: null, pricingSource: "unknown" }
    };
  };
}

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function inputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  for (const item of Object.values(record)) {
    if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") return (item as { text: string }).text;
  }
  return undefined;
}
