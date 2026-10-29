type Candidate = { id: string; provider: string; providerModelId: string; name: string; metadata?: Record<string, unknown> };
const hints = (model: Candidate) => model.metadata?.provider && typeof model.metadata.provider === "object" ? model.metadata.provider as Record<string, unknown> : model.metadata ?? {};
/** Uses normalized catalog metadata, whose provider hints live under metadata.provider. */
export function chooseBuzhaSubscription<T extends Candidate>(models: T[], provider: string, configured?: string): T | undefined {
  if (!["chatgpt_subscription", "claude_subscription"].includes(provider)) return undefined;
  const candidates = models.filter(model => model.provider === provider && hints(model).qualityHint === "high")
    .sort((a, b) => Number(hints(b).priority ?? 0) - Number(hints(a).priority ?? 0));
  return candidates.find(model => model.id === configured) ?? candidates[0];
}
