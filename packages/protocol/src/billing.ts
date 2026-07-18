export const CREDIT_UNIT = { creditsPerUsd: 100, microusdPerCredit: 10000 } as const;

export function creditsFromMicrousd(providerCostMicrousd: number): number {
  if (!Number.isFinite(providerCostMicrousd) || providerCostMicrousd <= 0) return 0;
  return Math.ceil(providerCostMicrousd / CREDIT_UNIT.microusdPerCredit);
}
