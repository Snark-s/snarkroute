import { readFile } from "node:fs/promises";
import { getLedgerPath } from "../server-paths";
export async function readLedgerRuns(): Promise<Array<Record<string, unknown>>> {
  let text = "";
  try {
    text = await readFile(getLedgerPath(), "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(stripSecretLikeFields);
}

export function summarizeLedgerRuns(runs: Array<Record<string, unknown>>) {
  const runsByProvider: Record<string, number> = {};
  const runsByStatus: Record<string, number> = {};
  let estimatedProviderCostTotal = 0;
  let estimatedCount = 0;
  let actualProviderCostTotal = 0;
  let actualCount = 0;

  for (const run of runs) {
    const status = String(run.status ?? "unknown");
    runsByStatus[status] = (runsByStatus[status] ?? 0) + 1;
    for (const provider of Array.isArray(run.providersUsed) ? run.providersUsed : []) {
      if (provider && typeof provider === "object") {
        const name = String((provider as Record<string, unknown>).provider ?? "unknown");
        runsByProvider[name] = (runsByProvider[name] ?? 0) + 1;
      }
    }
    if (typeof run.estimatedProviderCost === "number") {
      estimatedProviderCostTotal += run.estimatedProviderCost;
      estimatedCount += 1;
    }
    if (typeof run.actualProviderCost === "number") {
      actualProviderCostTotal += run.actualProviderCost;
      actualCount += 1;
    }
  }

  return {
    totalRuns: runs.length,
    runsByProvider,
    runsByStatus,
    estimatedProviderCostTotal: estimatedCount > 0 ? Number(estimatedProviderCostTotal.toFixed(6)) : null,
    actualProviderCostTotal: actualCount > 0 ? Number(actualProviderCostTotal.toFixed(6)) : null,
    paymentExecuted: false,
    paymentExecutedCount: 0,
    recentRuns: runs.slice(-10).reverse()
  };
}

function stripSecretLikeFields(value: unknown): Record<string, unknown> {
  return stripSecrets(value) as Record<string, unknown>;
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/token|secret|password|api[_-]?key/i.test(key))
        .map(([key, entry]) => [key, stripSecrets(entry)])
    );
  }
  return value;
}