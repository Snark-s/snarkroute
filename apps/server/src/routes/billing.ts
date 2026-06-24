import type { FastifyInstance } from "fastify";
import { parseRoute } from "@snarkroute/protocol";
import { getAuthAdapter } from "../auth/adapters";
import { getBillingAdapter } from "../billing/adapters";
import { listLocalDevCreditTransactions } from "../billing/local-dev-ledger";
import { errorMessage } from "../services/errors";
import { getCloudStorage } from "../services/cloud-storage";
import { isCloudStorageConfigured } from "../services/env";

type PublicCreditTransactionInput = {
  id: string;
  amount: number;
  transactionType: string;
  status: string;
  runId?: string | null;
  balanceAfter?: number | null;
  metadata?: unknown;
  createdAt: string;
};

export async function registerBillingRoutes(app: FastifyInstance) {
  app.get("/api/billing/balance", async (request, reply) => {
    try {
      const user = await getAuthAdapter().requireUser(request);
      return await getBillingAdapter().getBalance(user.id);
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/billing/transactions", async (request, reply) => {
    try {
      const user = await getAuthAdapter().requireUser(request);
      if (!isCloudStorageConfigured()) {
        const transactions = listLocalDevCreditTransactions({ userId: user.id, limit: Number(request.query.limit ?? 100) });
        return { transactions: transactions.map(publicCreditTransaction) };
      }
      const transactions = await getCloudStorage().listCreditTransactions({ userId: user.id, limit: Number(request.query.limit ?? 100) });
      return { transactions: transactions.map(publicCreditTransaction) };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/billing/estimate", async (request, reply) => {
    try {
      const route = parseRoute(request.body);
      const estimate = await getBillingAdapter().estimateRunCost(route);
      return estimate;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/routes/estimate", async (request, reply) => {
    try {
      const route = parseRoute(request.body);
      const estimate = await getBillingAdapter().estimateRunCost(route);
      const user = await getAuthAdapter().getCurrentUser(request);
      const balance = user ? await getBillingAdapter().getBalance(user.id) : null;
      return {
        ...estimate,
        balance: balance?.balance ?? null,
        canRun: balance ? balance.balance >= estimate.totalEstimatedCredits : false,
        nodes: estimate.estimates.map((entry) => ({
          nodeId: entry.nodeId,
          title: entry.pricingBreakdown?.title,
          provider: entry.provider ?? null,
          operation: entry.operation ?? null,
          model: entry.model ?? null,
          free: entry.free ?? entry.estimatedCredits <= 0,
          baseCostMicrousd: entry.baseCostMicrousd ?? 0,
          baseCredits: entry.baseCredits ?? 0,
          globalMarkupPercent: entry.globalMarkupPercent ?? 0,
          globalMarkupCredits: entry.globalMarkupCredits ?? 0,
          nodeMarkupPercent: entry.nodeMarkupPercent ?? 0,
          nodeMarkupCredits: entry.nodeMarkupCredits ?? 0,
          markupCredits: entry.markupCredits ?? 0,
          finalCredits: entry.finalCredits ?? entry.estimatedCredits,
          maxChargeCredits: entry.maxChargeCredits ?? entry.estimatedCredits,
          pricingSource: entry.pricingSource ?? "fallback_estimate",
          pricingConfidence: entry.pricingConfidence ?? "low",
          pricingSnapshotId: entry.pricingSnapshotId ?? entry.pricingBreakdown?.pricingSnapshotId ?? null,
          canonicalModelId: entry.canonicalModelId ?? entry.pricingBreakdown?.canonicalModelId ?? null,
          providerNativeModelId: entry.providerNativeModelId ?? entry.pricingBreakdown?.providerNativeModelId ?? null,
          fetchedAt: entry.fetchedAt ?? entry.pricingBreakdown?.fetchedAt ?? null,
          staleAfter: entry.staleAfter ?? entry.pricingBreakdown?.staleAfter ?? null,
          fallback: entry.fallback ?? entry.pricingBreakdown?.fallback ?? false
        }))
      };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function publicCreditTransaction(transaction: PublicCreditTransactionInput) {
  return {
    id: transaction.id,
    createdAt: transaction.createdAt,
    type: transaction.transactionType,
    amount: transaction.amount,
    status: transaction.status,
    balanceAfter: transaction.balanceAfter ?? null,
    reason: safeTransactionReason(transaction.metadata),
    runId: transaction.runId ?? null,
    provider: safeTransactionString(transaction.metadata, "provider"),
    nodeTitle: safeTransactionString(transaction.metadata, "nodeTitle"),
    maxChargeCredits: safeTransactionNumber(transaction.metadata, "maxChargeCredits")
  };
}

function safeTransactionReason(metadata: unknown): string | null {
  return safeTransactionString(metadata, "reason");
}

function safeTransactionString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  if (/secret|token|key|email|avatar|subject/i.test(key)) return null;
  return value.slice(0, 160);
}

function safeTransactionNumber(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
