import { afterEach, describe, expect, it, vi } from "vitest";
import { readYue2Status } from "../src/services/yue2-local";

describe("YuE2 local service health", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports stopped when the loopback service is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(readYue2Status()).resolves.toMatchObject({ status: "stopped", model_loaded: false });
  });

  it("rejects an unrelated process occupying the configured port", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ready" }) }));
    await expect(readYue2Status()).resolves.toMatchObject({ status: "error", error: expect.stringContaining("occupied") });
  });

  it("accepts the YuE2 health contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ service: "YuE2", status: "ready", model_loaded: true, generating: false })
    }));
    await expect(readYue2Status()).resolves.toMatchObject({ status: "ready", model_loaded: true });
  });
});
