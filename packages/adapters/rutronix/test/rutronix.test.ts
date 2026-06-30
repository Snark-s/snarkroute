import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuTronixClient, normalizeRuTronixProviderCostFromUsage, RUTRONIX_CHAT_PATH } from "../src/index";

describe("RuTronix adapter", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the documented Bearer chat endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    await createRuTronixClient({ apiKey: "secret", fetchImpl }).chatCompletions({ model: "gpt-4o", messages: [] });
    expect(fetchImpl).toHaveBeenCalledWith(`https://api.rutronix.ai${RUTRONIX_CHAT_PATH}`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }));
  });
  it("converts explicit RUB usage to USD", () => {
    vi.stubEnv("BOOJUM_RUB_PER_USD", "100");
    expect(normalizeRuTronixProviderCostFromUsage({ cost: 25, currency: "RUB" })).toEqual({ amountUsd: 0.25, currency: "USD", sourceCurrency: "RUB" });
  });
  it("fails closed when the RUB FX rate is unavailable", () => {
    vi.stubEnv("BOOJUM_RUB_PER_USD", "");
    expect(normalizeRuTronixProviderCostFromUsage({ cost_rub: 25 })).toEqual({ amountUsd: null, currency: "unknown", sourceCurrency: "RUB" });
  });
});
