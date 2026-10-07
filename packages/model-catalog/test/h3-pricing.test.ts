import { describe, expect, it } from "vitest";
import { listSeedProviderPricingV1 } from "../src/index.js";

describe("H3 Max pricing metadata", () => {
  it("keeps current Max/Turbo output rates separate from reference endpoint rates", () => {
    const entries = listSeedProviderPricingV1().filter((entry) => entry.provider === "minimax-h3" && entry.providerModelId === "h3_max");
    const turboEntries = listSeedProviderPricingV1().filter((entry) => entry.provider === "minimax-h3" && entry.providerModelId === "h3_max_turbo");
    const standard768 = entries.find((entry) => entry.priceParams?.resolution === "768P" && entry.priceParams?.endpointMode === "standard");
    const reference768 = entries.find((entry) => entry.priceParams?.resolution === "768P" && entry.priceParams?.endpointMode === "reference-to-video");

    const turbo768 = turboEntries.find((entry) => entry.priceParams?.resolution === "768P");
    expect(standard768).toMatchObject({ priceUnit: "second", providerCostMicrousd: 80_000, pricingConfidence: "high" });
    expect(turbo768).toMatchObject({ priceUnit: "second", providerCostMicrousd: 40_000, pricingConfidence: "high" });
    expect(reference768).toMatchObject({ priceUnit: "second", providerCostMicrousd: 80_000, pricingConfidence: "high" });
    expect(reference768?.rawProviderPricing).toMatchObject({ includedReferenceTokens: 4096, referenceMicrousdPer1000Tokens: 20_000 });
  });
});
