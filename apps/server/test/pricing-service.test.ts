import { describe, expect, it } from "vitest";
import { __testing, getEffectivePricingState, pricingCatalogState, savePricingConfig } from "../src/billing/pricing-service";

describe("pricing service", () => {
  it("creates per-model OpenRouter image prices from provider model catalog pricing", () => {
    const entries = __testing.pricingEntriesFromOpenRouterModelCatalog({
      refreshedAt: "2026-06-23T21:04:00.106Z",
      models: [
        {
          id: "openrouter/image-exact",
          kind: "image",
          architecture: { output_modalities: ["image"] },
          pricing: { request: "0.03" }
        },
        {
          id: "openrouter/image-token-priced",
          kind: "text",
          architecture: { output_modalities: ["image", "text"] },
          pricing: { prompt: "0.000001", completion: "0.000002" }
        },
        {
          id: "openrouter/text-token-priced",
          kind: "text",
          architecture: { output_modalities: ["text"] },
          pricing: { prompt: "0.000001", completion: "0.000002" }
        },
        {
          id: "openrouter/no-pricing"
        }
      ]
    });

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "openrouter",
        operation: "image.generate",
        model: "openrouter/image-exact",
        baseCostMicrousd: 30000,
        source: "openrouter_models_catalog"
      }),
      expect.objectContaining({
        provider: "openrouter",
        operation: "image.generate",
        model: "openrouter/image-token-priced",
        baseCostMicrousd: 9192,
        source: "openrouter_models_catalog_token_estimate"
      })
    ]));
    expect(entries.find((entry) => entry.model === "openrouter/no-pricing")).toBeUndefined();
    expect(entries.find((entry) => entry.model === "openrouter/text-token-priced" && entry.operation === "image.generate")).toBeUndefined();
  });

  it("normalizes Polza tier pricing from RUB before creating credit catalog entries", () => {
    process.env.BOOJUM_RUB_PER_USD = "80";
    const entries = __testing.pricingEntriesFromPolzaCatalog({
      fetchedAt: "2026-06-23T21:04:00.106Z",
      expiresAt: "2026-06-24T21:04:00.106Z",
      source: "polza_models_catalog",
      models: {
        "openai/gpt-5.4-image-2": {
          currency: "RUB",
          raw: { type: "image" },
          pricing: { tiers: [{ cost: 4, conditions: ["image_resolution=1K"] }] }
        }
      }
    });

    expect(entries).toEqual([
      expect.objectContaining({
        provider: "polza",
        model: "openai/gpt-5.4-image-2",
        operation: "image.generate",
        baseCostMicrousd: 50000,
        parameterRules: { image_resolution: "1K" }
      })
    ]);
    delete process.env.BOOJUM_RUB_PER_USD;
  });

  it("applies admin pricing config in local mode without a database", async () => {
    __testing.resetLocalPricingState();
    delete process.env.DATABASE_URL;
    await savePricingConfig({ globalMarkupPercent: 11, globalMarkupCredits: 0, minChargeCredits: 0, actorUserId: "admin" });

    const state = await pricingCatalogState();
    const geminiFallback = state.pricing.find((entry) => entry.provider === "gemini" && entry.operation === "image.generate" && entry.fallback);

    expect(state.source).toBe("local_override");
    expect(geminiFallback).toMatchObject({
      baseCredits: 4,
      globalMarkupPercent: 11,
      finalCredits: 5
    });
    __testing.resetLocalPricingState();
  });

  it("uses model and resolution specific Gemini image pricing before fallback", async () => {
    __testing.resetLocalPricingState();
    delete process.env.DATABASE_URL;
    process.env.BOOJUM_GLOBAL_MARKUP_PERCENT = "0";
    process.env.BOOJUM_GLOBAL_MARKUP_CREDITS = "0";
    process.env.BOOJUM_MIN_CHARGE_CREDITS = "0";
    const state = await pricingCatalogState();
    const twoKCatalogEntry = state.providerCatalog.find((entry) =>
      entry.provider === "gemini"
      && entry.operation === "image.generate"
      && entry.model === "gemini-3.1-flash-image-preview"
      && entry.parameterRules?.image_resolution === "2K"
    );
    const twoK = state.pricing.find((entry) =>
      entry.provider === "gemini"
      && entry.operation === "image.generate"
      && entry.model === "gemini-3.1-flash-image-preview"
      && entry.baseCredits === 11
    );

    expect(twoKCatalogEntry).toBeTruthy();
    expect(twoK).toMatchObject({
      baseCredits: 11,
      finalCredits: 11,
      pricingConfidence: "high",
      fallback: false
    });
  });

  it("reapplies the provider pricing catalog to process env on cache hits", async () => {
    __testing.resetLocalPricingState();
    delete process.env.DATABASE_URL;
    delete process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON;

    const coldState = await getEffectivePricingState();
    expect(coldState.providerCatalog.length).toBeGreaterThan(0);
    delete process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON;

    const cachedState = await getEffectivePricingState();
    const envCatalog = JSON.parse(process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON ?? "[]");

    expect(cachedState).toBe(coldState);
    expect(envCatalog.length).toBe(coldState.providerCatalog.length);
    __testing.resetLocalPricingState();
  });
});
