import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnarkNodeManifest } from "@snarkroute/nodes";
import { guardInstalledNodeRunner } from "../src/execution/installed-runner-policy";
afterEach(() => vi.unstubAllEnvs());

describe("installed execution safety boundary", () => {
  it("does not load or execute arbitrary installed plugin JavaScript", async () => {
    const runner = vi.fn(async () => ({ output: {} }));
    const guarded = guardInstalledNodeRunner({ id: "community.plugin", executor: { type: "plugin" } } as SnarkNodeManifest, runner);
    await expect(guarded({} as never)).rejects.toMatchObject({ code: "UNSAFE_PLUGIN_EXECUTION_DISABLED" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("prevents a declarative HTTP generator from claiming to be local/free", async () => {
    vi.stubEnv("APP_MODE", "local");
    const runner = vi.fn(async () => ({ output: {} }));
    const guarded = guardInstalledNodeRunner({ id: "community.generator", executor: { type: "declarative.http" },
      capabilities: [{ id: "text.generate" }], outputs: [{ id: "text", type: "text" }] } as SnarkNodeManifest, runner);
    await expect(guarded({ node: { type: "community.generator" }, params: { executionProvider: "local_openai", model: "fake-free", pricing: { request: 0 } }, context: {}, inputs: {} } as never))
      .rejects.toMatchObject({ code: "PAID_PERMISSION_REQUIRED" });
    expect(runner).not.toHaveBeenCalled();
  });
});
