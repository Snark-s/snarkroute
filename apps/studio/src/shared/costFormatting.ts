import type { CostEstimate, CreditTransaction, RouteDoc, RunCostSummary } from "../studioTypes";

export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "unlimited";
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export function formatSignedCredits(value: number): string {
  return `${value > 0 ? "+" : ""}${formatCredits(value)} credits`;
}

export function formatMicrousd(value: number): string {
  if (!Number.isFinite(value)) return "0.000000";
  return (value / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export function normalizeCreditTransaction(value: unknown): CreditTransaction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : `${record.createdAt ?? ""}:${record.type ?? ""}:${record.amount ?? ""}`;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : typeof record.created_at === "string" ? record.created_at : "";
  const type = typeof record.type === "string" ? record.type : typeof record.transactionType === "string" ? record.transactionType : "";
  const amount = Number(record.amount ?? 0);
  if (!id || !createdAt || !type || !Number.isFinite(amount)) return null;
  return {
    id,
    createdAt,
    type,
    amount,
    status: typeof record.status === "string" ? record.status : undefined,
    balanceAfter: typeof record.balanceAfter === "number" ? record.balanceAfter : null,
    reason: typeof record.reason === "string" ? record.reason : null,
    runId: typeof record.runId === "string" ? record.runId : null,
    nodeTitle: typeof record.nodeTitle === "string" ? record.nodeTitle : null,
    provider: typeof record.provider === "string" ? record.provider : null,
    maxChargeCredits: typeof record.maxChargeCredits === "number" ? record.maxChargeCredits : null
  };
}

export function creditTransactionLine(transaction: CreditTransaction): string {
  const balance = transaction.balanceAfter === null || transaction.balanceAfter === undefined ? "" : ` -> ${formatCredits(transaction.balanceAfter)}`;
  return `${transaction.type} ${formatSignedCredits(transaction.amount)}${balance}`;
}

export function creditTransactionDetails(transaction: CreditTransaction): string {
  const details = [
    transaction.reason,
    transaction.nodeTitle,
    transaction.provider,
    transaction.runId ? `run ${transaction.runId}` : null
  ].filter((item): item is string => Boolean(item));
  return details.length ? details.join(" / ") : "-";
}

export function creditPriceExplanation(costEstimate: CostEstimate): string {
  const provider = costEstimate.provider ?? providerFromNodeType(costEstimate.nodeType) ?? "unknown";
  const operation = costEstimate.operation ?? operationFromNodeType(costEstimate.nodeType);
  const breakdown = costEstimate.pricingBreakdown;
  if (breakdown) {
    return [
      `Base API cost: ${formatCredits(breakdown.baseCredits ?? 0)} credits`,
      `Global markup: +${formatCredits(breakdown.globalMarkupPercent ?? 0)}% +${formatCredits(breakdown.globalMarkupCredits ?? 0)} credits`,
      `Node markup: +${formatCredits(breakdown.nodeMarkupPercent ?? 0)}% +${formatCredits(breakdown.nodeMarkupCredits ?? 0)} credits`,
      `Final: ${formatCredits(breakdown.finalCredits ?? costEstimate.estimatedCredits)} credits`,
      `Source: ${breakdown.pricingSource ?? costEstimate.pricingSource ?? "pricing catalog"}`,
      `Confidence: ${breakdown.pricingConfidence ?? costEstimate.pricingConfidence ?? "unknown"}`
    ].join("\n");
  }
  return [
    `provider=${provider}`,
    `operation=${operation}`,
    `source=${costEstimate.pricingSource ?? "pricing catalog"}`,
    `maxChargeCredits=${formatCredits(costEstimate.estimatedCredits)}`
  ].join("\n");
}

export function userFacingCostEstimates(route: RouteDoc, summary: RunCostSummary | null): Array<CostEstimate & { label: string }> {
  if (!summary) return [];
  const labels = routeNodeLabels(route);
  return summary.estimates
    .filter((entry) => isUserFacingCostEntry(entry.nodeType, entry.estimatedCredits))
    .map((entry) => ({ ...entry, label: labels.get(entry.nodeId) ?? humanizeNodeId(entry.nodeId) }));
}

export function userFacingCostActuals(route: RouteDoc, summary: RunCostSummary | undefined): Array<CostEstimate & { actualCredits: number; actualProviderCostAmount: number | null; label: string }> {
  if (!summary) return [];
  const labels = routeNodeLabels(route);
  return summary.actuals
    .filter((entry) => isUserFacingCostEntry(entry.nodeType, entry.actualCredits))
    .map((entry) => ({ ...entry, label: labels.get(entry.nodeId) ?? humanizeNodeId(entry.nodeId) }));
}

export function sumNumbers(values: number[]): number {
  return Number(values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0).toFixed(6));
}

export function userFacingErrorMessage(message: string): string {
  if (/ENOENT|no such file or directory/i.test(message)) {
    if (/input|readFile|image|\.png|\.jpe?g|\.webp/i.test(message)) return "Input image not found. Please re-upload the image.";
    return "Result could not be saved. Please retry.";
  }
  if (/[A-Z]:\\|\/Users\/|\/var\/|\/tmp\/|SnarkRoute|apps[\\/]/i.test(message)) return "Result could not be saved. Please retry.";
  return message;
}

export function formatRunCostEstimate(summary: RunCostSummary, balance: { balance: number; currency: string } | null, enough: boolean): string {
  const lines = ["Estimated total:"];
  for (const entry of summary.estimates) {
    lines.push(`${entry.nodeId.padEnd(18)} ${formatCredits(entry.estimatedCredits)} credits`);
  }
  lines.push("--------------------------");
  lines.push(`${"Total".padEnd(18)} ${formatCredits(summary.totalEstimatedCredits)} credits`);
  lines.push("");
  lines.push(`${"Balance".padEnd(18)} ${balance ? `${formatCredits(balance.balance)} credits` : "unknown"}`);
  lines.push(enough ? "Enough credits" : "Not enough credits");
  return lines.join("\n");
}

export function formatRunCostActual(summary: RunCostSummary): string {
  const lines = ["Actual total:"];
  for (const entry of summary.actuals) {
    lines.push(`${entry.nodeId.padEnd(18)} ${formatCredits(entry.actualCredits)} credits`);
  }
  lines.push("--------------------------");
  lines.push(`${"Total".padEnd(18)} ${formatCredits(summary.totalActualCredits)} credits`);
  lines.push(`${"Refunded".padEnd(18)} ${formatCredits(summary.refundedCredits)} credits`);
  return lines.join("\n");
}

function providerFromNodeType(nodeType: string): string | null {
  if (nodeType.startsWith("polza.")) return "polza";
  if (nodeType.startsWith("replicate.")) return "replicate";
  if (nodeType.startsWith("gemini.")) return "gemini";
  return null;
}

function operationFromNodeType(nodeType: string): string {
  if (nodeType === "polza.image.generate" || nodeType.includes("image.generate")) return "image.generate";
  if (nodeType === "polza.video.generate" || nodeType.includes("video.generate")) return "video.generate";
  if (nodeType.includes("upscaler") || nodeType.includes("upscale")) return "image.upscale";
  if (nodeType.includes("text") || nodeType.includes("llm")) return "text.generate";
  return nodeType;
}

function routeNodeLabels(route: RouteDoc): Map<string, string> {
  return new Map(route.nodes.map((node) => [node.id, node.title?.trim() || humanizeNodeId(node.id)]));
}

function isUserFacingCostEntry(nodeType: string, credits: number): boolean {
  if (!Number.isFinite(credits) || credits <= 0) return false;
  return !isFreeUserFacingNodeType(nodeType);
}

function isFreeUserFacingNodeType(type: string): boolean {
  return type.startsWith("input.")
    || type.startsWith("output.")
    || type.startsWith("preview.")
    || type.startsWith("debug.")
    || type.startsWith("utility.")
    || type.startsWith("library.")
    || type.startsWith("compound.")
    || type === "text.promptCompose";
}

function humanizeNodeId(id: string): string {
  return id
    .replace(/[_-]+\d+$/g, "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
