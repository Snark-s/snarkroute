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
  function residentTextModel(freeMiB = 3072): LocalRuntimeSnapshot {
    const value = snapshot({ memory: { totalMiB: 32768, usedMiB: 32768 - freeMiB, freeMiB } });
    value.runtimes[0] = { ...value.runtimes[0], id: "ollama", label: "Ollama", state: "ready", online: true,
      resourceClaim: "resident", residentModelIds: ["qwen3:8b"] };
    return value;
  }

  it("admits the exact loaded text model with 3 GB free without requiring another weight load", () => {
    const decision = planLocalRuntimeAdmission("ollama", residentTextModel(), "workload", "qwen3:8b");
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });

  it("keeps RAM confirmation for another model, an unknown model, and startup", () => {
    const value = residentTextModel();
    expect(planLocalRuntimeAdmission("ollama", value, "workload", "qwen3:14b").requiresConfirmation).toBe(true);
    expect(planLocalRuntimeAdmission("ollama", value).requiresConfirmation).toBe(true);
    expect(planLocalRuntimeAdmission("ollama", value, "start", "qwen3:8b").requiresConfirmation).toBe(true);
  });

  it("keeps RAM confirmation below 2 GB even for the exact resident model", () => {
    expect(planLocalRuntimeAdmission("ollama", residentTextModel(1536), "workload", "qwen3:8b").requiresConfirmation).toBe(true);
  });

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

  it("does not count a resident runtime's own VRAM as pressure against its own workload", () => {
    // Bonsai 27B alone holds ~10 GB on a 16 GB card; with the desktop the GPU reads 78% used.
    const value = snapshot({
      gpu: { name: "RTX 3080 Laptop", totalMiB: 16384, usedMiB: 12855, freeMiB: 3321, utilizationPercent: 11 }
    });
    value.runtimes[0] = { ...value.runtimes[0], state: "ready", online: true, resourceClaim: "resident", control: { canStart: false, canStop: true } };

    const decision = planLocalRuntimeAdmission("bonsai", value);

    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.warnings).toEqual([]);
  });

  it("still requires confirmation for a resident runtime when another heavy runtime overlaps", () => {
    const value = snapshot({
      gpu: { name: "RTX 3080 Laptop", totalMiB: 16384, usedMiB: 12855, freeMiB: 3321, utilizationPercent: 11 }
    });
    value.runtimes[0] = { ...value.runtimes[0], state: "ready", online: true, resourceClaim: "resident", control: { canStart: false, canStop: true } };
    value.runtimes[2] = { ...value.runtimes[2], state: "ready", online: true, resourceClaim: "resident", control: { canStart: false, canStop: true } };

    const decision = planLocalRuntimeAdmission("bonsai", value);

    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.conflictingRuntimeIds).toContain("yue2");
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
