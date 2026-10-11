import { describe, expect, it } from "vitest";
import { providerHttpError } from "../src/index";

describe("structured external provider failures", () => {
  it("C: identifies provider 402 by origin/code/status rather than text", () => {
    expect(providerHttpError(402, "polza", "balance unavailable")).toMatchObject({
      errorCode: "provider_insufficient_funds", code: "PROVIDER_INSUFFICIENT_FUNDS", providerId: "polza",
      origin: "provider", statusCode: 402, retryable: false,
      details: { origin: "provider", providerId: "polza", statusCode: 402 }
    });
    expect(providerHttpError(404, "openrouter", "nested string 402 is not a billing signal")).toMatchObject({ code: "PROVIDER_NOT_FOUND", statusCode: 404, retryable: false });
  });

  it("distinguishes rate limits, authorization, timeouts and upstream unavailability", () => {
    for (const [status, code, retryable] of [[401, "PROVIDER_AUTH", false], [403, "PROVIDER_AUTH", false],
      [408, "PROVIDER_TIMEOUT", true], [429, "PROVIDER_RATE_LIMIT", true], [503, "PROVIDER_UNAVAILABLE", true]] as const) {
      expect(providerHttpError(status, "openrouter", "fixture")).toMatchObject({ code, retryable, origin: "provider", statusCode: status });
    }
  });
});
