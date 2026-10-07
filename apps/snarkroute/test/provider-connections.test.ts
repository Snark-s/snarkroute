import { describe, expect, it } from "vitest";
import { isProviderConnectionTest, providerConnectionViewStatus } from "../src/providerConnections";

describe("provider connection UI state", () => {
  it("does not treat configured as verified", () => {
    expect(providerConnectionViewStatus({ configured: true, offline: false })).toBe("configured");
  });

  it("shows verified only after a successful live test", () => {
    expect(providerConnectionViewStatus({
      configured: true,
      offline: false,
      testState: { loading: false, result: { status: "verified", ok: true } }
    })).toBe("verified");
  });

  it("keeps unsupported providers configured", () => {
    expect(providerConnectionViewStatus({
      configured: true,
      offline: false,
      testState: { loading: false, result: { status: "unsupported", ok: null } }
    })).toBe("configured");
  });

  it("rejects malformed server results", () => {
    expect(isProviderConnectionTest({ status: "connected", ok: true })).toBe(false);
    expect(isProviderConnectionTest({ status: "verified", ok: false })).toBe(false);
  });
});
