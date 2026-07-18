import type { NodeResult, RunResult } from "@snarkroute/executor";
import { getRubPerUsd } from "@snarkroute/protocol";
import { saveLocalDevProviderUsageEvent } from "./local-dev-credit-store";
import { getCloudStorage } from "../services/cloud-storage";
import { isCloudStorageConfigured } from "../services/env";
import { redactSecrets } from "../services/errors";

export type ProviderUsagePersistOptions = {
  userId?: string | null;
  recordCredits?: boolean;
};

export async function saveProviderUsageEventsForRunResult(runResult: Pick<RunResult, "runId" | "nodeResults">, options: ProviderUsagePersistOptions = {}): Promise<void> {
  await Promise.all(Object.values(runResult.nodeResults ?? {}).map((nodeResult) =>
    saveProviderUsageEventsForNodeResult(runResult.runId, null, nodeResult, options)
  ));
}

export async function saveProviderUsageEventsForNodeResult(runId: string | null, nodeRunId: string | null, nodeResult: NodeResult, options: ProviderUsagePersistOptions = {}): Promise<void> {
  const estimate = nodeResult.costEstimate;
  const events = nodeResult.providerUsage?.length ? nodeResult.providerUsage : estimate?.provider ? [{ provider: estimate.provider, model: estimate.model, status: nodeResult.status }] : [];
  for (const event of events) {
    const provider = event.provider;
    if (!provider) continue;
    const chargeCredits = options.recordCredits === true && isBillableNodeResult(nodeResult, event.status);
    const pricing = nodeResult.costEstimate?.pricingBreakdown;
    const actualCostAmount = event.actualCost ?? nodeResult.actualProviderCostAmount ?? null;
    const actualCostCurrency = event.actualCostCurrency ?? nodeResult.actualProviderCostCurrency ?? nodeResult.costEstimate?.providerCostCurrency ?? null;
    const actualProviderCostMicrousd = microusdFromProviderCost(actualCostAmount, actualCostCurrency);
    const usageEvent = {
      runId,
      nodeRunId,
      userId: options.userId ?? null,
      nodeId: nodeResult.nodeId,
      nodeType: nodeResult.type,
      provider,
      modelId: event.providerModel ?? event.model ?? estimate?.model ?? null,
      operation: pricing?.operation ?? operationForProviderUsage(nodeResult.type),
      status: event.status ?? nodeResult.status,
      usage: safeJson(event.metrics ?? nodeResult.actualUsage ?? {}),
      estimatedCredits: estimate?.estimatedCredits ?? null,
      actualCredits: chargeCredits ? nodeResult.actualCredits ?? 0 : 0,
      usageSource: nodeResult.usageSource ?? estimate?.usageSource ?? "unknown",
      providerCostEstimateAmount: event.estimatedCost ?? estimate?.estimatedProviderCostAmount ?? null,
      providerCostActualAmount: actualCostAmount,
      providerCostMicrousd: event.providerCostMicrousd ?? actualProviderCostMicrousd ?? pricing?.providerCostMicrousd ?? null,
      baseCredits: event.baseCredits ?? pricing?.baseCredits ?? null,
      markupCredits: event.markupCredits ?? pricing?.markupCredits ?? null,
      finalCredits: event.finalCredits ?? pricing?.finalCredits ?? null,
      pricingSource: event.pricingSource ?? pricing?.pricingSource ?? null,
      pricingConfidence: event.pricingConfidence ?? pricing?.pricingConfidence ?? null,
      pricingSnapshotId: pricing?.pricingSnapshotId ?? null,
      canonicalModelId: pricing?.canonicalModelId ?? null,
      providerNativeModelId: pricing?.providerNativeModelId ?? null,
      currency: actualCostCurrency,
      providerRequestId: event.externalId ?? null,
      metadata: safeJson({ pricingHint: event.pricingHint, pricingSource: event.pricingSource, pricingQuote: event.pricingQuote, pricingBreakdown: pricing })
    };
    if (isCloudStorageConfigured()) await getCloudStorage().saveProviderUsageEvent(usageEvent);
    else saveLocalDevProviderUsageEvent(usageEvent);
  }
}

function microusdFromProviderCost(cost: number | null | undefined, currency: string | null | undefined): number | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) return null;
  const normalizedCurrency = currency?.toUpperCase();
  if (!normalizedCurrency) return null;
  if (normalizedCurrency === "USD") return Math.ceil(cost * 1_000_000);
  if (normalizedCurrency === "RUB") {
    const rate = getRubPerUsd();
    return rate ? Math.ceil((cost / rate) * 1_000_000) : null;
  }
  return null;
}

export function operationForProviderUsage(nodeType: string): string {
  if (/upscale/i.test(nodeType)) return "image.upscale";
  if (/audio|speech|sound|music/i.test(nodeType)) return "audio.generate";
  if (/video/i.test(nodeType)) return "video.generate";
  if (/text|llm/i.test(nodeType)) return "text.generate";
  if (/image|gemini\.nano-banana-2/i.test(nodeType)) return "image.generate";
  return nodeType;
}

export function isBillableNodeResult(nodeResult: NodeResult, providerStatus?: unknown): boolean {
  if (nodeResult.status !== "succeeded") return false;
  if (providerStatus && /^(failed|failure|error|errored|cancelled|canceled|timeout|timed_out|unavailable|auth_error|quota_exceeded)$/i.test(String(providerStatus))) return false;
  return true;
}

function safeJson(value: unknown): unknown {
  return JSON.parse(redactSecrets(JSON.stringify(value ?? {})));
}
