import { describe, expect, it } from "vitest";
import { planLocalRuntimeAdmission, type LocalRuntimeSnapshot } from "./local-runtime-supervisor";

function snapshot(overrides: Partial<LocalRuntimeSnapshot> = {}): LocalRuntimeSnapshot {
  return {
    capturedAt: "2026-10-07T09:00:00.000Z",
    gpu: { name: "RTX 3080 Laptop", totalMiB: 16384, usedMiB: 1500, freeMiB: 14884, utilizationPercent: 5 },
    memory: { totalMiB: 65536, usedMiB: 24576, freeMiB: 40960 },
    pressure: { level: "idle", summary: "Свободно." },
    runtimes: [
      { id: "bonsai", label: "Bonsai", state: "stopped", online: false, busy: false, resourceClaim: "none", demand: "heavy", claimsOnStart: true, control: { canStart: true, canStop: false } },
      { id: "h3", label: "H3", state: "stopped", online: false, busy: false, resourceClaim: "none", demand: "exclusive", claimsOnStart: false, control: { canStart: true, canStop: false } },
      { id: "yue2", label: "YuE2", state: "stopped", online: false, busy: false, resourceClaim: "none", demand: "heavy", claimsOnStart: true, control: { canStart: true, canStop: false } },
      { id: "upscale", label: "Upscale", state: "stopped", online: false, busy: false, resourceClaim: "none", demand: "heavy", claimsOnStart: false, control: { canStart: true, canStop: false } }
    ],
    ...overrides
  };
}

describe("local runtime admission", () => {
  it("blocks a local H3 workload while Bonsai keeps a large model resident", () => {
    const value = snapshot();
    value.runtimes[0] = { ...value.runtimes[0], state: "ready", online: true, resourceClaim: "resident", control: { canStart: false, canStop: true } };

    const decision = planLocalRuntimeAdmission("h3", value);

    expect(decision.allowed).toBe(false);
    expect(decision.conflictingRuntimeIds).toContain("bonsai");
    expect(decision.blockers.join(" ")).toMatch(/Bonsai/);
  });

  it("does not treat an idle H3 worker as a GPU conflict", () => {
    const value = snapshot();
    value.runtimes[1] = { ...value.runtimes[1], state: "ready", online: true, resourceClaim: "none", control: { canStart: false, canStop: true } };

    const decision = planLocalRuntimeAdmission("bonsai", value);

    expect(decision.allowed).toBe(true);
    expect(decision.conflictingRuntimeIds).not.toContain("h3");
  });

  it("blocks a heavy runtime while H3 is actively rendering", () => {
    const value = snapshot();
    value.runtimes[1] = { ...value.runtimes[1], state: "busy", online: true, busy: true, resourceClaim: "active", control: { canStart: false, canStop: true } };

    const decision = planLocalRuntimeAdmission("bonsai", value);

    expect(decision.allowed).toBe(false);
    expect(decision.conflictingRuntimeIds).toEqual(["h3"]);
  });

  it("warns instead of pretending unknown GPU pressure is safe", () => {
    const value = snapshot({
      gpu: { name: "RTX 3080 Laptop", totalMiB: 16384, usedMiB: 13000, freeMiB: 3384, utilizationPercent: 92 }
    });

    const decision = planLocalRuntimeAdmission("bonsai", value);

    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.warnings.join(" ")).toMatch(/GPU/);
  });

  it("starting an idle daemon does not reserve its workload resources", () => {
    const value = snapshot();
    value.runtimes[0] = { ...value.runtimes[0], state: "ready", online: true, resourceClaim: "resident", control: { canStart: false, canStop: true } };

    const decision = planLocalRuntimeAdmission("h3", value, "start");

    expect(decision.allowed).toBe(true);
    expect(decision.conflictingRuntimeIds).toEqual([]);
  });

  it("requires confirmation when two resident-heavy runtimes would overlap", () => {
    const value = snapshot();
    value.runtimes[2] = { ...value.runtimes[2], state: "ready", online: true, resourceClaim: "resident", control: { canStart: false, canStop: true } };

    const decision = planLocalRuntimeAdmission("bonsai", value);

    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.conflictingRuntimeIds).toContain("yue2");
  });

  it("warns when an automatically discovered runtime has unknown resource requirements", () => {
    const value = snapshot();
    value.runtimes.push({
      id: "local_openai-127-0-0-1-17777",
      label: "Local OpenAI",
      state: "ready",
      online: true,
      busy: false,
      resourceClaim: "unknown",
      demand: "unknown",
      claimsOnStart: false,
      control: { canStart: false, canStop: false },
      discovered: true
    });

    const decision = planLocalRuntimeAdmission("bonsai", value);

    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.conflictingRuntimeIds).toContain("local_openai-127-0-0-1-17777");
    expect(decision.warnings.join(" ")).toMatch(/не знает|неизвест/i);
  });
});
