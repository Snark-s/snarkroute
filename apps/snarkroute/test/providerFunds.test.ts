import { describe, expect, it } from "vitest";
import { activeProviderFunds, clearProviderFundsOnSuccess, markProviderFundsError, resolveProviderRoute } from "../src/providerFunds";

describe("provider funds state", () => {
  it("marks insufficient-funds failures and clears the provider after success", () => {
    const marked = markProviderFundsError({}, { errorCode: "provider_insufficient_funds", providerId: "polza" }, 100);
    expect(marked).toEqual({ polza: { status: "insufficient", at: 100 } });
    expect(clearProviderFundsOnSuccess(marked, "polza")).toEqual({});
  });

  it("ignores flags older than the TTL", () => {
    expect(activeProviderFunds({ polza: { status: "insufficient", at: 100 } }, 201, 100)).toEqual({});
  });

  it("prefers a funded route for auto and falls back to the first route when all are flagged", () => {
    const routes = [{ providerId: "polza" }, { providerId: "openrouter" }];
    expect(resolveProviderRoute(routes, "auto", { polza: { status: "insufficient", at: 100 } }, 150, 100)?.providerId).toBe("openrouter");
    expect(resolveProviderRoute(routes, "auto", {
      polza: { status: "insufficient", at: 100 },
      openrouter: { status: "insufficient", at: 100 }
    }, 150, 100)?.providerId).toBe("polza");
    expect(routes).toHaveLength(2);
  });
});
