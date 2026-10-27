import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModelPricingInfoV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { appMode } from "../services/env";
import { errorMessage } from "../services/errors";
import { isLoopbackAddress, isLoopbackHost } from "./after-effects";
import { loadLiveModelCatalogV1 } from "./models";
import { readOpenRouterModelCatalogCache } from "@snarkroute/openrouter";
import { openRouterCatalogCachePath } from "../server-paths";

export type BuzhaModel = { id: string; name: string; provider: string; providerModelId: string; pricing?: ModelPricingInfoV1 };
const ROOT = "/api/system/buzha";

/** These existing text transports make a single inference POST, with no paid retry or fallback.
 * Other provider transports can be exposed once they offer the same guarantee.
 */
export async function buzhaModels(): Promise<BuzhaModel[]> {
  const [catalog, cache] = await Promise.all([loadLiveModelCatalogV1("ai.text"), readOpenRouterModelCatalogCache(openRouterCatalogCachePath)]);
  const prices = new Map(cache?.models.map(model => [model.id, model.pricing]));
  return catalog.filter(model => ["openrouter", "local_openai"].includes(model.provider)
    && model.availability.status === "available" && model.availability.configured !== false
    && model.inputTypes.includes("text") && model.outputTypes.includes("text"))
    .map(model => ({ id: `${model.provider}:${model.providerModelId}`, name: model.displayName,
      provider: model.provider, providerModelId: model.providerModelId, pricing: model.pricing ?? (model.provider === "local_openai"
        ? { status: "fresh" as const, source: "manual" as const, currency: "USD", unit: "token", pricing: { prompt: 0, completion: 0 } }
        : prices.get(model.providerModelId) ? { status: "unknown" as const,
          source: "provider-cache" as const, currency: "USD", unit: "token", pricing: prices.get(model.providerModelId), refreshedAt: cache?.refreshedAt } : undefined) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function local(request: FastifyRequest): boolean {
  if (appMode() !== "local" || !isLoopbackAddress(request.ip) || !isLoopbackHost(request.hostname)) return false;
  if (!request.headers.origin) return true;
  try { const url = new URL(request.headers.origin); return url.protocol === "http:" && isLoopbackHost(url.hostname); }
  catch { return false; }
}
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Compatibility only: inference, permission checks, billing and persistence remain in SnarkRoute's Model Gateway. */
export function registerBuzhaModelGateway(app: FastifyInstance, deps = { models: buzhaModels }): void {
  app.get(ROOT + "/models", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    try { return reply.header("cache-control", "no-store").send({ ok: true, models: await deps.models() }); }
    catch (error) { return reply.code(503).send({ error: { message: errorMessage(error), retryable: false } }); }
  });

  app.post(ROOT + "/chat/completions", { bodyLimit: 200_000 }, async (request, reply) => {
    const fail = (status: number, message: string, code = "buzha_gateway_error", extra = {}) =>
      reply.code(status).send({ ...extra, error: { message, code, retryable: false } });
    if (!local(request)) return fail(403, "Local client required.");
    const body = record(request.body);
    const messages = body.messages;
    if (body.stream === true || !Array.isArray(messages) || !messages.length || messages.length > 31
        || messages.some(message => !["system", "user", "assistant"].includes(message?.role)
          || typeof message?.content !== "string" || message.content.length > 100_000)) {
      return fail(400, "A bounded text conversation is required; tools and streaming are unavailable.");
    }
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    reply.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
    try {
      const model = (await deps.models()).find(entry => entry.id === body.model);
      if (!model) return fail(404, "Выбери доступную модель из каталога SnarkRoute.", "model_unavailable");
      // Opaque prompt encoding preserves literal {{...}} in user text through route interpolation.
      const prompt = messages.map(message => `${message.role}:\n${message.content}`).join("\n\n");
      const response = await app.inject({ method: "POST", url: "/api/routes/run", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]), payload: { route: {
        routeVersion: "0.1", route: { id: `buzha-${randomUUID()}`, title: "Бужа · разговор", author: { name: "SnarkRoute" } },
        nodes: [{ id: "chat", type: "ai.text", params: {
          model: model.providerModelId, providerModelId: model.providerModelId, executionProvider: model.provider,
          promptBase64: Buffer.from(prompt, "utf8").toString("base64"), max_tokens: 1024,
          pricing: model.pricing?.pricing, routingPolicy: { allowPaid: true }
        } }], edges: []
      } } });
      const result = response.json();
      const node = record(result.nodeResults?.chat);
      const output = record(node.output);
      const costs = { providerCost: node.actualProviderCostAmount ?? output.actualCost ?? null,
        baseCost: node.actualProviderCostAmount ?? output.actualCost ?? null,
        estimatedCost: output.estimatedCost ?? null,
        currency: node.actualProviderCostCurrency ?? output.actualCostCurrency ?? output.estimatedCostCurrency ?? model.pricing?.currency ?? null,
        credits: node.actualCredits ?? null };
      const provenance = { ...record(node.provenance), provider: model.provider, model: output.model ?? model.providerModelId, runId: result.runId };
      const accounting = { costs, costSummary: result.costSummary ?? null, economics: result.economics ?? null, provenance };
      if (response.statusCode !== 200 || result.status !== "succeeded" || typeof output.text !== "string" || !output.text.trim()) {
        return fail(502, errorMessage(node.error ?? result.error ?? "Модель не вернула текст. Автоматического повтора нет."), node.errorCode ?? "model_request_failed", accounting);
      }
      return { id: result.runId, object: "chat.completion", model: output.model ?? model.providerModelId,
        choices: [{ index: 0, message: { role: "assistant", content: output.text }, finish_reason: "stop" }],
        usage: output.actualUsage ?? null, ...accounting };
    } catch (error) { return fail(502, errorMessage(error)); }
  });
}
