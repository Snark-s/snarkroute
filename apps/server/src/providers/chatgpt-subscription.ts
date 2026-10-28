import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";
import { normalizeProviderModelToV1Input, type ProviderModelInfoV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { CodexCliError } from "../services/codex-cli";
import {
  aliasForModelRef,
  CHATGPT_DEFAULT_ALIAS,
  CHATGPT_SUBSCRIPTION_PROVIDER,
  chatGptSubscription,
  isChatGptSubscriptionEnabled,
  modelRefForAlias,
  type ChatGptSubscriptionService
} from "../services/chatgpt-subscription";
import { ModelRoutingPolicyError } from "../services/model-routing-policy";
import { promptFromParams, recordValue, stringValue } from "./subscription-text";

/** Catalog entries for the owner's ChatGPT plan. Models and availability are live: CLI, ChatGPT login, quota, per-model blocks. */
export async function chatGptSubscriptionModelsForCatalogV1(service: ChatGptSubscriptionService = chatGptSubscription(), env: NodeJS.ProcessEnv = process.env): Promise<ProviderModelInfoV1[]> {
  const enabled = isChatGptSubscriptionEnabled(env);
  const refreshedAt = new Date().toISOString();
  const [auth, models] = enabled
    ? await Promise.all([service.auth().catch(() => undefined), service.models(env)])
    : [undefined, [{ alias: CHATGPT_DEFAULT_ALIAS, displayName: "ChatGPT (модель Codex по умолчанию)", priority: 0 }]];
  const quota = service.quotaState();
  return models.map((info, index) => {
    const alias = info.alias;
    const model = service.modelState(alias);
    const reason = !enabled ? "ChatGPT Subscription выключен (CHATGPT_SUBSCRIPTION_ENABLED=1 в .env)."
      : !auth ? "Не удалось проверить Codex CLI."
        : !auth.subscription ? auth.reason
          : quota.exhausted ? `Лимит подписки исчерпан${quota.exhaustedUntil ? `, сброс ${quota.exhaustedUntil}` : ""}.`
            : !model.available ? model.reason : undefined;
    const fast = /fast|efficient|affordable|mini/i.test(`${info.description ?? ""} ${alias}`);
    return normalizeProviderModelToV1Input({
      provider: CHATGPT_SUBSCRIPTION_PROVIDER,
      providerModelId: modelRefForAlias(alias),
      canonicalModelId: modelRefForAlias(alias),
      displayName: `${info.displayName} · подписка ChatGPT`,
      originVendor: "openai",
      inputTypes: ["text"],
      outputTypes: ["text"],
      capabilities: ["text.generate"],
      roles: ["generator"],
      availability: { status: reason ? "unavailable" : "available", source: "live", configured: enabled, refreshedAt, reason },
      pricing: {
        status: "fresh",
        source: "manual",
        currency: "USD",
        unit: "request",
        pricing: { request: 0, prompt: 0, completion: 0 },
        refreshedAt,
        warning: "Входит в подписку ChatGPT Plus/Pro: оплаты за запрос нет, расходуется лимит подписки."
      },
      metadata: {
        subscription: true,
        transport: "codex-cli",
        cliModel: alias === CHATGPT_DEFAULT_ALIAS ? undefined : alias,
        description: info.description,
        resolvedModel: model.resolvedModel,
        planType: quota.lastRateLimit?.planType,
        apiCost: 0,
        priority: Math.max(40, 75 - index * 5),
        qualityHint: fast ? "medium" : "high",
        speedHint: fast ? "fast" : "medium",
        costHint: "subscription",
        autoEligible: !reason,
        supportsTools: false,
        supportsStreaming: false,
        supportsConversations: true,
        quotaResetsAt: quota.exhaustedUntil
      }
    });
  });
}

export function createChatGptSubscriptionTextNodeRunner(service: ChatGptSubscriptionService = chatGptSubscription()): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    if (!isChatGptSubscriptionEnabled()) throw new ModelRoutingPolicyError("PROVIDER_DISABLED", "ChatGPT Subscription выключен (CHATGPT_SUBSCRIPTION_ENABLED=1).", CHATGPT_SUBSCRIPTION_PROVIDER);
    if (Array.isArray(params.tools) && params.tools.length) {
      throw new ModelRoutingPolicyError("TOOLS_UNSUPPORTED", "ChatGPT Subscription работает через Codex CLI без инструментов; tool calling не поддерживается.", CHATGPT_SUBSCRIPTION_PROVIDER);
    }
    const modelRef = stringValue(params.providerModelId) ?? stringValue(params.model) ?? modelRefForAlias(CHATGPT_DEFAULT_ALIAS);
    const conversationId = stringValue(params.conversationId);
    const { systemPrompt, prompt } = promptFromParams(params, inputs, Boolean(conversationId));
    if (!prompt) throw new Error("ChatGPT Subscription requires a prompt or messages.");
    const jsonObject = recordValue(params.response_format).type === "json_object";
    try {
      void context.reportProgress?.(0.1, "running");
      const result = await service.chat({
        modelRef,
        prompt,
        systemPrompt: jsonObject ? `${systemPrompt ?? ""}\n\nRespond with one valid JSON object and nothing else.`.trim() : systemPrompt,
        conversationId,
        signal: context.signal,
        caller: `route:${context.route.route.id}`
      });
      const usage = { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens + result.usage.reasoningOutputTokens };
      const providerUsage: ProviderUsageEvent = {
        provider: CHATGPT_SUBSCRIPTION_PROVIDER,
        model: result.model,
        providerModel: result.modelRef,
        logicalModel: stringValue(params.model),
        nodeId: node.id,
        nodeType: node.type,
        status: "succeeded",
        metrics: { ...usage, cached_prompt_tokens: result.usage.cachedInputTokens, reasoning_tokens: result.usage.reasoningOutputTokens },
        estimatedCost: 0,
        actualCost: 0,
        actualCostCurrency: "USD",
        pricingHint: "subscription_included",
        pricingSource: "subscription",
        providerCostMicrousd: 0,
        baseCredits: 0,
        markupCredits: 0,
        finalCredits: 0,
        pricingConfidence: "high"
      };
      const ignored = ["temperature", "top_p", "max_tokens", "max_completion_tokens"].filter(key => params[key] !== undefined);
      return {
        output: {
          text: result.text,
          provider: CHATGPT_SUBSCRIPTION_PROVIDER,
          logicalModel: stringValue(params.model),
          model: result.model,
          providerModel: result.modelRef,
          conversationId: result.conversationId,
          sessionId: result.sessionId,
          estimatedCost: 0,
          estimatedCostCurrency: "USD",
          estimatedCostConfidence: "high",
          actualUsage: usage,
          actualCost: 0,
          actualCostCurrency: "USD",
          pricingSource: "subscription",
          status: "succeeded"
        },
        logs: [
          `Generated text with ChatGPT ${result.alias} (${result.model}) through the Codex CLI subscription`,
          ...result.warnings.map(warning => `Codex: ${warning}`),
          ...(ignored.length ? [`Codex CLI has no ${ignored.join(", ")} parameters; ignored.`] : [])
        ],
        metrics: { chatgptSubscription: { durationMs: result.durationMs, alias: result.alias, planType: result.rateLimit?.planType, primaryUsedPercent: result.rateLimit?.primary?.usedPercent } },
        provenance: { provider: CHATGPT_SUBSCRIPTION_PROVIDER, model: result.model, transport: "codex-cli", subscription: true },
        providerUsage
      };
    } catch (error) {
      if (error instanceof CodexCliError) {
        // Typed codes let automatic routing fall back to another permitted model instead of retrying blindly.
        const wrapped = new ModelRoutingPolicyError(error.code, error.message, CHATGPT_SUBSCRIPTION_PROVIDER);
        Object.assign(wrapped.details, { resetsAt: error.details.resetsAt, alias: aliasForModelRef(modelRef), modelRef });
        throw wrapped;
      }
      throw error;
    }
  };
}
