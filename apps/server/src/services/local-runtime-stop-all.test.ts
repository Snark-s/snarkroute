import { describe, expect, it, vi } from "vitest";
import { stopAllLocalRuntimes } from "./local-runtime-stop-all";

describe("stop all managed local tasks", () => {
  it("includes Buzha and skips processes without an owned stop controller", async () => {
    const stop = vi.fn(async (_id: string) => ({}));
    const result = await stopAllLocalRuntimes({ snapshot: async () => ({ runtimes: [
      { id: "buzha", control: { canStop: true } },
      { id: "foreign", control: { canStop: false } },
      { id: "stopped", control: { canStop: false } }
    ] }), stop });
    expect(stop.mock.calls).toEqual([["buzha"]]);
    expect(result).toEqual([{ id: "buzha", ok: true }]);
  });

  it("reports a refused stop and continues other owned tasks without retrying", async () => {
    const stop = vi.fn(async (id: string) => { if (id === "foreign") throw new Error("Ownership not verified"); });
    const result = await stopAllLocalRuntimes({ snapshot: async () => ({ runtimes: [
      { id: "foreign", control: { canStop: true } }, { id: "buzha", control: { canStop: true } }
    ] }), stop });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ id: "foreign", ok: false, error: "Ownership not verified" }, { id: "buzha", ok: true }]);
  });
});
