export const PROVIDER_INSUFFICIENT_FUNDS_ERROR_CODE = "provider_insufficient_funds" as const;
export const DEFAULT_PROVIDER_FUNDS_TTL_MS = 6 * 60 * 60 * 1000;

export interface ProviderFundsEntry {
  status: "insufficient";
  at: number;
}

export type ProviderFunds = Record<string, ProviderFundsEntry>;

export function activeProviderFunds(funds: ProviderFunds, now = Date.now(), ttlMs = DEFAULT_PROVIDER_FUNDS_TTL_MS): ProviderFunds {
  return Object.fromEntries(Object.entries(funds).filter(([, entry]) => entry.status === "insufficient" && now - entry.at < ttlMs));
}

export function markProviderFundsError(funds: ProviderFunds, error: { errorCode?: string; providerId?: string }, now = Date.now()): ProviderFunds {
  if (error.errorCode !== PROVIDER_INSUFFICIENT_FUNDS_ERROR_CODE || !error.providerId) return funds;
  return { ...funds, [error.providerId]: { status: "insufficient", at: now } };
}

export function clearProviderFundsOnSuccess(funds: ProviderFunds, providerId: string | undefined): ProviderFunds {
  if (!providerId || !funds[providerId]) return funds;
  const next = { ...funds };
  delete next[providerId];
  return next;
}

export function providerFundsWarning(funds: ProviderFunds, providerId: string, now = Date.now(), ttlMs = DEFAULT_PROVIDER_FUNDS_TTL_MS): string | undefined {
  return activeProviderFunds(funds, now, ttlMs)[providerId] ? "Provider account may be out of funds" : undefined;
}

export function resolveProviderRoute<T extends { providerId: string }>(routes: T[], executionProvider: string, funds: ProviderFunds, now = Date.now(), ttlMs = DEFAULT_PROVIDER_FUNDS_TTL_MS): T | undefined {
  if (executionProvider !== "auto") return routes.find((route) => route.providerId === executionProvider) ?? routes[0];
  const active = activeProviderFunds(funds, now, ttlMs);
  return routes.find((route) => !active[route.providerId]) ?? routes[0];
}
