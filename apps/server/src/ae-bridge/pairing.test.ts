import { describe, expect, it } from "vitest";
import { AeBridgePairingService } from "./pairing";

const localContext = { remoteAddress: "127.0.0.1", origin: "null" };

describe("AeBridgePairingService", () => {
  it("issues a short-lived credential that can only be consumed once", () => {
    const pairing = new AeBridgePairingService(5_000);
    const issued = pairing.issue(localContext, 1_000);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.expiresAt).toBe(6_000);
    expect(pairing.consume(issued.token, localContext, 2_000)).toBe(true);
    expect(pairing.consume(issued.token, localContext, 2_001)).toBe(false);
  });

  it("rejects expired credentials and credentials used from another client context", () => {
    const pairing = new AeBridgePairingService(100);
    const expired = pairing.issue(localContext, 1_000);
    const mismatched = pairing.issue(localContext, 1_000);

    expect(pairing.consume(expired.token, localContext, 1_101)).toBe(false);
    expect(pairing.consume(mismatched.token, { remoteAddress: "::1", origin: "null" }, 1_050)).toBe(false);
  });
});
