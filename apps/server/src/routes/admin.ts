import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/adapters";
import { getEffectivePricingState, pricingCatalogState, savePricingConfig, savePricingOverride } from "../billing/pricing-service";
import { getCloudStorage } from "../services/cloud-storage";
import { isGeminiEnabled, isOpenAiEnabled, isOpenRouterEnabled, isPolzaEnabled, isReplicateEnabled, isSeedanceEnabled } from "../services/env";
import { errorMessage } from "../services/errors";

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/admin/pricing/config", async (request, reply) => {
    try {
      await requireAdmin(request);
      return await getEffectivePricingState();
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.post<{ Body: { globalMarkupPercent?: number; globalMarkupCredits?: number; minChargeCredits?: number; reason?: string } }>("/api/admin/pricing/config", async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      const percent = Number(request.body?.globalMarkupPercent ?? 0);
      const credits = Number(request.body?.globalMarkupCredits ?? 0);
      const minCharge = Number(request.body?.minChargeCredits ?? 0);
      return await savePricingConfig({ globalMarkupPercent: percent, globalMarkupCredits: credits, minChargeCredits: minCharge, actorUserId: admin.id, reason: request.body?.reason ?? null });
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 400).send({ error: message });
    }
  });

  app.post<{ Body: { provider?: string; operation?: string; model?: string; nodeType?: string; markupPercent?: number; markupCredits?: number; enabled?: boolean; reason?: string } }>("/api/admin/pricing/overrides", async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      return await savePricingOverride({
        provider: request.body?.provider ?? null,
        operation: request.body?.operation ?? null,
        model: request.body?.model ?? null,
        nodeType: request.body?.nodeType ?? null,
        markupPercent: Number(request.body?.markupPercent ?? 0),
        markupCredits: Number(request.body?.markupCredits ?? 0),
        enabled: request.body?.enabled !== false,
        reason: request.body?.reason ?? null,
        actorUserId: admin.id
      });
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 400).send({ error: message });
    }
  });

  app.get("/api/admin/pricing/catalog", async (request, reply) => {
    try {
      await requireAdmin(request);
      return await pricingCatalogState();
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.get("/api/admin/overview", async (_request, reply) => {
    try {
      await requireAdmin(_request);
      const overview = await getCloudStorage().adminOverview();
      return {
        ...overview,
        providerKeyStatus: {
          openrouter: isOpenRouterEnabled(),
          polza: isPolzaEnabled(),
          replicate: isReplicateEnabled(),
          gemini: isGeminiEnabled(),
          openai: isOpenAiEnabled(),
          seedance: isSeedanceEnabled()
        }
      };
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.get("/api/admin/billing/balances", async (request, reply) => {
    try {
      await requireAdmin(request);
      return await getCloudStorage().listUserBalances();
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.get("/api/admin/users", async (request, reply) => {
    try {
      await requireAdmin(request);
      return { users: await getCloudStorage().adminBillingUsers() };
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.get<{ Params: { userId: string } }>("/api/admin/users/:userId", async (request, reply) => {
    try {
      await requireAdmin(request);
      const user = await getCloudStorage().adminBillingUser(request.params.userId);
      if (!user) return reply.code(404).send({ error: "User was not found." });
      return publicAdminUserCard(user);
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.get<{ Params: { userId: string }; Querystring: { limit?: string } }>("/api/admin/users/:userId/transactions", async (request, reply) => {
    try {
      await requireAdmin(request);
      const limit = Number(request.query.limit ?? 100);
      const transactions = await getCloudStorage().listCreditTransactions({ userId: request.params.userId, limit });
      const providerUsage = await getCloudStorage().listUserProviderUsage({ userId: request.params.userId, limit });
      return { transactions: transactions.map((transaction) => publicAdminTransaction(transaction, providerUsage)) };
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.post<{ Params: { userId: string }; Body: { amount?: number; reason?: string } }>("/api/admin/users/:userId/grant-credits", async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      const userId = request.params.userId;
      const amount = Number(request.body?.amount);
      const reason = request.body?.reason?.trim();
      if (!Number.isInteger(amount) || amount <= 0 || !reason) return reply.code(400).send({ error: "Positive integer amount and reason are required." });
      const result = await getCloudStorage().grantCredits({ userId, amount, reason, actorUserId: admin.id });
      await getCloudStorage().writeAuditEvent({ actorUserId: admin.id, eventType: "admin_credit_grant", metadata: { targetUserId: userId, amount, reason, transactionId: result.transactionId } });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : message.includes("not found") ? 404 : 500).send({ error: message });
    }
  });

  app.post<{ Params: { userId: string }; Body: { amount?: number; reason?: string } }>("/api/admin/users/:userId/adjust-credits", async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      const userId = request.params.userId;
      const amount = Number(request.body?.amount);
      const reason = request.body?.reason?.trim();
      if (!Number.isInteger(amount) || amount === 0 || !reason) return reply.code(400).send({ error: "Non-zero integer amount and reason are required." });
      const result = await getCloudStorage().adjustCredits({ userId, amount, reason, actorUserId: admin.id, allowNegativeBalance: process.env.BOOJUM_ALLOW_NEGATIVE_BALANCE === "true" });
      await getCloudStorage().writeAuditEvent({ actorUserId: admin.id, eventType: "admin_credit_adjustment", metadata: { targetUserId: userId, amount, reason, transactionId: result.transactionId } });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : message.includes("Insufficient credits") ? 400 : 500).send({ error: message });
    }
  });

  app.get<{ Querystring: { userId?: string; limit?: string } }>("/api/admin/billing/transactions", async (request, reply) => {
    try {
      await requireAdmin(request);
      return await getCloudStorage().listCreditTransactions({ userId: request.query.userId, limit: Number(request.query.limit ?? 100) });
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.post<{ Body: { userId?: string; amount?: number; reason?: string } }>("/api/admin/billing/grants", async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      const userId = request.body?.userId?.trim();
      const amount = Number(request.body?.amount);
      const reason = request.body?.reason?.trim() || "admin_grant";
      if (!userId || !Number.isInteger(amount) || amount <= 0) return reply.code(400).send({ error: "userId and positive integer amount are required." });
      const result = await getCloudStorage().grantCredits({ userId, amount, reason, actorUserId: admin.id });
      await getCloudStorage().writeAuditEvent({ actorUserId: admin.id, eventType: "admin_credit_grant", metadata: { targetUserId: userId, amount, reason, transactionId: result.transactionId } });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });

  app.post<{ Body: { userId?: string; amount?: number; reason?: string } }>("/api/admin/billing/adjustments", async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      const userId = request.body?.userId?.trim();
      const amount = Number(request.body?.amount);
      const reason = request.body?.reason?.trim() || "admin_adjustment";
      if (!userId || !Number.isInteger(amount) || amount === 0) return reply.code(400).send({ error: "userId and non-zero integer amount are required." });
      const result = await getCloudStorage().adjustCredits({ userId, amount, reason, actorUserId: admin.id, allowNegativeBalance: process.env.BOOJUM_ALLOW_NEGATIVE_BALANCE === "true" });
      await getCloudStorage().writeAuditEvent({ actorUserId: admin.id, eventType: "admin_credit_adjustment", metadata: { targetUserId: userId, amount, reason, transactionId: result.transactionId } });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes("Admin access") ? 403 : 500).send({ error: message });
    }
  });
}

function publicAdminUserCard(user: any) {
  return {
    id: user.id,
    role: user.role,
    createdAt: user.createdAt,
    authProviders: user.authProviders,
    providerSubjectHashPrefix: user.providerSubjectHashPrefix ?? null,
    currentBalance: user.currentBalance,
    totalGranted: user.totalGranted,
    totalCaptured: user.totalCaptured,
    totalReleased: user.totalReleased,
    totalRefunded: user.totalRefunded,
    activeReserved: user.activeReserved,
    runsCount: user.runsCount,
    lastActivityAt: user.lastActivityAt,
    providerUsageCount: user.providerUsageCount,
    recentRuns: user.recentRuns,
    recentCreditTransactions: user.recentCreditTransactions.map((transaction: any) => publicAdminTransaction(transaction, user.recentProviderUsage)),
    recentProviderUsage: user.recentProviderUsage
  };
}

function publicAdminTransaction(transaction: any, providerUsage: unknown[]) {
  const usage = Array.isArray(providerUsage)
    ? providerUsage.find((entry: any) => entry?.run_id && entry.run_id === transaction.runId)
    : null;
  return {
    id: transaction.id,
    createdAt: transaction.createdAt,
    type: transaction.transactionType,
    amount: transaction.amount,
    status: transaction.status,
    reservationId: transaction.reservationId ?? null,
    runId: transaction.runId ?? null,
    nodeRunId: (usage as any)?.node_run_id ?? null,
    provider: (usage as any)?.provider ?? safeMetadataString(transaction.metadata, "provider"),
    operation: (usage as any)?.operation ?? safeMetadataString(transaction.metadata, "operation"),
    reason: safeMetadataString(transaction.metadata, "reason"),
    balanceAfter: transaction.balanceAfter ?? null
  };
}

function safeMetadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  if (/secret|token|key|email|avatar|subject/i.test(key)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value.slice(0, 160) : null;
}
