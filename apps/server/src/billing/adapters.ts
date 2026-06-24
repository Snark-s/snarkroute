import type { OpenRoute } from "@snarkroute/protocol";
import { estimateRouteCost, type RunCostSummary } from "@snarkroute/executor";
import { appMode, isCloudStorageConfigured } from "../services/env";
import { getCloudStorage } from "../services/cloud-storage";
import { getEffectivePricingState } from "./pricing-service";
import { commitLocalDevCredits, getLocalDevBalance, refundLocalDevCredits, reserveLocalDevCredits } from "./local-dev-ledger";

export interface CreditBillingAdapter {
  getBalance(userId: string): Promise<{ balance: number; currency: string }>;
  estimateRunCost(route: OpenRoute): Promise<RunCostSummary>;
  reserveCredits(runId: string, amount: number, userId?: string): Promise<{ reservationId: string; amount: number }>;
  commitCredits(reservationId: string, actualAmount: number): Promise<{ charged: number; refunded: number }>;
  refundCredits(reservationId: string, amount: number): Promise<{ refunded: number }>;
}

export class NoopBillingAdapter implements CreditBillingAdapter {
  async getBalance(): Promise<{ balance: number; currency: string }> {
    return { balance: 999999999, currency: "credits" };
  }

  async estimateRunCost(route: OpenRoute): Promise<RunCostSummary> {
    const pricing = await getEffectivePricingState();
    const estimate = estimateRouteCost(route, undefined, { providerCatalog: pricing.providerCatalog, config: pricing.config, overrides: pricing.overrides });
    return {
      ...estimate,
      estimates: estimate.estimates.map((entry) => ({ ...entry, estimatedCredits: 0 })),
      totalEstimatedCredits: 0
    };
  }

  async reserveCredits(): Promise<{ reservationId: string; amount: number }> {
    return { reservationId: "noop", amount: 0 };
  }

  async commitCredits(): Promise<{ charged: number; refunded: number }> {
    return { charged: 0, refunded: 0 };
  }

  async refundCredits(): Promise<{ refunded: number }> {
    return { refunded: 0 };
  }
}

export class CloudCreditBillingAdapter implements CreditBillingAdapter {
  async getBalance(userId: string): Promise<{ balance: number; currency: string }> {
    if (!isCloudStorageConfigured()) return getLocalDevBalance(userId);
    const balance = await getCloudStorage().getCreditBalance(userId);
    return { balance: balance.balance, currency: "credits" };
  }

  async estimateRunCost(route: OpenRoute): Promise<RunCostSummary> {
    const pricing = await getEffectivePricingState();
    const estimate = estimateRouteCost(route, undefined, { providerCatalog: pricing.providerCatalog, config: pricing.config, overrides: pricing.overrides });
    if (billingMode(route) === "byok") {
      return {
        ...estimate,
        estimates: estimate.estimates.map((entry) => ({ ...entry, estimatedCredits: 0 })),
        totalEstimatedCredits: 0
      };
    }
    return estimate;
  }

  async reserveCredits(runId: string, amount: number, userId?: string): Promise<{ reservationId: string; amount: number }> {
    if (amount <= 0) return { reservationId: "byok", amount: 0 };
    if (!isCloudStorageConfigured()) {
      if (!userId) throw new Error("userId is required to reserve local development credits.");
      return reserveLocalDevCredits({ userId, runId, amount });
    }
    if (!userId) throw new Error("userId is required to reserve cloud credits.");
    return getCloudStorage().reserveCredits({ userId, runId, amount });
  }

  async commitCredits(reservationId: string, actualAmount: number): Promise<{ charged: number; refunded: number }> {
    if (reservationId === "byok" || reservationId === "noop") return { charged: 0, refunded: 0 };
    if (!isCloudStorageConfigured()) return commitLocalDevCredits({ reservationId, actualAmount });
    return getCloudStorage().commitCredits({ reservationId, actualAmount });
  }

  async refundCredits(reservationId: string, amount: number): Promise<{ refunded: number }> {
    if (reservationId === "byok" || reservationId === "noop") return { refunded: 0 };
    if (!isCloudStorageConfigured()) return refundLocalDevCredits({ reservationId, amount });
    return getCloudStorage().refundCredits({ reservationId, amount });
  }
}

export function getBillingAdapter(): CreditBillingAdapter {
  return appMode() === "cloud" ? new CloudCreditBillingAdapter() : new NoopBillingAdapter();
}

function billingMode(route?: OpenRoute): "server" | "byok" {
  if (route && routeUsesUserSessionCredentials(route)) return "byok";
  return process.env.BOOJUM_BILLING_MODE?.trim().toLowerCase() === "byok" ? "byok" : "server";
}

function routeUsesUserSessionCredentials(route: OpenRoute): boolean {
  return route.nodes.some((node) => {
    const params = node.params ?? {};
    return params.credentialMode === "user-session";
  });
}
