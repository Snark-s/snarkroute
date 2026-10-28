import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";
import { normalizeProviderModelToV1Input, type ProviderModelInfoV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { ClaudeCliError } from "../services/claude-code-cli";
import {
  aliasForModelRef,
  CLAUDE_SUBSCRIPTION_PROVIDER,
  claudeSubscription,
  isClaudeSubscriptionEnabled,
  modelRefForAlias,
  type ClaudeSubscriptionService
} from "../services/claude-subscription";
import { ModelRoutingPolicyError } from "../services/model-routing-policy";

const DISPLAY: Record<string, { name: string; priority: number; quality: string; speed: string }> = {
  opus: { name: "Claude Opus · подписка", priority: 70, quality: "high", speed: "slow" },
  sonnet: { name: "Claude Sonnet · подписка", priority: 80, quality: "high", speed: "medium" },
  haiku: { name: "Claude Haiku · подписка", priority: 60, quality: "medium", speed: "fast" }
};

/** Catalog entries for the owner's Claude plan. Availability is live: CLI installed, subscription login, quota, per-model blocks. */
export async function claudeSubscriptionModelsForCatalogV1(service: ClaudeSubscriptionService = claudeSubscription(), env: NodeJS.ProcessEnv = process.env): Promise<ProviderModelInfoV1[]> {
  const enabled = isClaudeSubscriptionEnabled(env);
  const refreshedAt = new Date().toISOString();
  const auth = enabled ? await service.auth().catch(() => undefined) : undefined;
  const quota = service.quotaState();
  return service.aliases(env).map(alias => {
    const model = service.modelState(alias);
    const reason = !enabled ? "Claude Subscription выключен (CLAUDE_SUBSCRIPTION_ENABLED=1 в .env)."
      : !auth ? "Не удалось проверить Claude Code CLI."
        : !auth.subscription ? auth.reason
          : quota.exhausted ? `Лимит подписки исчерпан${quota.exhaustedUntil ? `, сброс ${quota.exhaustedUntil}` : ""}.`
            : !model.available ? model.reason : undefined;
    const display = DISPLAY[alias] ?? { name: `Claude ${alias} · подписка`, priority: 50, quality: "high", speed: "medium" };
    return normalizeProviderModelToV1Input({
      provider: CLAUDE_SUBSCRIPTION_PROVIDER,
      providerModelId: modelRefForAlias(alias),
      canonicalModelId: modelRefForAlias(alias),
      displayName: display.name,
      originVendor: "anthropic",
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
        warning: "Входит в подписку Claude Pro/Max: оплаты за запрос нет, расходуется лимит подписки."
      },
      metadata: {
        subscription: true,
        transport: "claude-code-cli",
        cliAlias: alias,
        resolvedModel: model.resolvedModel,
        subscriptionType: auth?.subscriptionType,
        apiCost: 0,
        priority: display.priority,
        qualityHint: display.quality,
        speedHint: display.speed,
        costHint: "subscription",
        autoEligible: !reason,
        supportsTools: false,
        supportsStreaming: true,
        supportsConversations: true,
        quotaResetsAt: quota.exhaustedUntil
      }
    });
  });
}

type ChatMessage = { role: string; content: string };

export function createClaudeSubscriptionTextNodeRunner(service: ClaudeSubscriptionService = claudeSubscription()): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    if (!isClaudeSubscriptionEnabled()) throw new ModelRoutingPolicyError("PROVIDER_DISABLED", "Claude Subscription выключен (CLAUDE_SUBSCRIPTION_ENABLED=1).", CLAUDE_SUBSCRIPTION_PROVIDER);
    if (Array.isArray(params.tools) && params.tools.length) {
      throw new ModelRoutingPolicyError("TOOLS_UNSUPPORTED", "Claude Subscription работает через Claude Code CLI без инструментов; tool calling не поддерживается.", CLAUDE_SUBSCRIPTION_PROVIDER);
    }
    const modelRef = stringValue(params.providerModelId) ?? stringValue(params.model) ?? modelRefForAlias("sonnet");
    const conversationId = stringValue(params.conversationId);
    const { systemPrompt, prompt } = promptFromParams(params, inputs, Boolean(conversationId));
    if (!prompt) throw new Error("Claude Subscription requires a prompt or messages.");
    const jsonObject = recordValue(params.response_format).type === "json_object";
    let streamed = 0;
    try {
      const result = await service.chat({
        modelRef,
        prompt,
        systemPrompt: jsonObject ? `${systemPrompt ?? ""}\n\nRespond with one valid JSON object and nothing else.`.trim() : systemPrompt,
        conversationId,
        signal: context.signal,
        caller: `route:${context.route.route.id}`,
        onEvent: event => {
          if (event.type === "delta") {
            streamed += event.text.length;
            void context.reportProgress?.(Math.min(0.95, streamed / 4_000), "streaming");
          }
        }
      });
      const usage = { prompt_tokens: result.usage.inputTokens + result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens, completion_tokens: result.usage.outputTokens };
      const providerUsage: ProviderUsageEvent = {
        provider: CLAUDE_SUBSCRIPTION_PROVIDER,
        model: result.model,
        providerModel: result.modelRef,
        logicalModel: stringValue(params.model),
        nodeId: node.id,
        nodeType: node.type,
        status: "succeeded",
        metrics: { ...usage, apiEquivalentCostUsd: result.apiEquivalentCostUsd },
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
          provider: CLAUDE_SUBSCRIPTION_PROVIDER,
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
          apiEquivalentCostUsd: result.apiEquivalentCostUsd,
          pricingSource: "subscription",
          status: "succeeded"
        },
        logs: [
          `Generated text with Claude ${result.alias} (${result.model}) through the Claude Code subscription`,
          ...(ignored.length ? [`Claude Code CLI has no ${ignored.join(", ")} parameters; ignored.`] : [])
        ],
        metrics: { claudeSubscription: { durationMs: result.durationMs, alias: result.alias, rateLimit: result.rateLimit?.status } },
        provenance: { provider: CLAUDE_SUBSCRIPTION_PROVIDER, model: result.model, transport: "claude-code-cli", subscription: true },
        providerUsage
      };
    } catch (error) {
      if (error instanceof ClaudeCliError) {
        // Typed codes let automatic routing fall back to another permitted tier instead of retrying blindly.
        const wrapped = new ModelRoutingPolicyError(error.code, error.message, CLAUDE_SUBSCRIPTION_PROVIDER);
        Object.assign(wrapped.details, { resetsAt: error.details.resetsAt, alias: aliasForModelRef(modelRef) });
        throw wrapped;
      }
      throw error;
    }
  };
}

export function promptFromParams(params: Record<string, unknown>, inputs: Record<string, unknown>, conversation: boolean): { systemPrompt?: string; prompt: string } {
  const messages = (Array.isArray(params.messages) ? params.messages : [])
    .map(item => recordValue(item))
    .map((item): ChatMessage => ({ role: stringValue(item.role) ?? "user", content: contentText(item.content) }))
    .filter(item => item.content);
  const system = [stringValue(params.system), stringValue(params.systemPrompt), ...messages.filter(item => item.role === "system").map(item => item.content)]
    .filter((item): item is string => Boolean(item)).join("\n\n") || undefined;
  const turns = messages.filter(item => item.role !== "system");
  if (!turns.length) return { systemPrompt: system, prompt: stringValue(params.prompt) ?? stringValue(inputs.prompt) ?? stringValue(inputs.text) ?? "" };
  // A persisted conversation already holds earlier turns; only the newest user turn is sent.
  if (conversation || turns.length === 1) return { systemPrompt: system, prompt: turns[turns.length - 1].content };
  const transcript = turns.slice(0, -1).map(item => `<${item.role}>\n${item.content}\n</${item.role}>`).join("\n");
  return { systemPrompt: system, prompt: `Earlier conversation:\n${transcript}\n\nReply to the latest message:\n${turns[turns.length - 1].content}` };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => recordValue(part)).filter(part => part.type === "text" || typeof part.text === "string").map(part => String(part.text ?? "")).join("");
}
function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
