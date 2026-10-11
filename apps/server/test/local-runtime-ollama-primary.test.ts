import { afterEach, describe, expect, it, vi } from "vitest";

// Only the network status probes are stubbed; endpoint configuration and the runtime registry are real.
vi.mock("../src/services/bonsai-local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/bonsai-local")>()),
  readBonsaiStatus: vi.fn(async () => ({ status: "stopped" }))
}));
vi.mock("../src/services/ollama-local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ollama-local")>()),
  readOllamaStatus: vi.fn(async () => ({ status: "ready", online: true, residentModels: [] }))
}));
vi.mock("../src/services/h3-connection", () => ({ inspectH3Connection: vi.fn(async () => ({ ready: false, activeJobs: 0 })) }));
vi.mock("../src/services/yue2-local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/yue2-local")>()),
  readYue2Status: vi.fn(async () => ({ status: "stopped", generating: false, model_loaded: false }))
}));
vi.mock("../src/services/local-upscale-local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/local-upscale-local")>()),
  readLocalUpscaleStatus: vi.fn(async () => ({ state: "stopped", online: false, configured: false, activeJobs: 0 }))
}));

afterEach(() => { vi.unstubAllEnvs(); });

describe("Ollama as the primary local endpoint", () => {
  it("keeps the built-in Ollama profile so local work is admitted without a false GPU warning", async () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434/v1");
    vi.stubEnv("LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON", "");
    const { readLocalRuntimeSnapshot, planLocalRuntimeAdmission } = await import("../src/services/local-runtime-supervisor");
    const snapshot = await readLocalRuntimeSnapshot();
    const ollama = snapshot.runtimes.find(runtime => runtime.id === "ollama");
    expect(ollama).toMatchObject({ label: "Ollama", demand: "heavy" });
    snapshot.gpu = { name: "fixture", totalMiB: 16384, usedMiB: 1024, freeMiB: 15360, utilizationPercent: 0 };
    snapshot.memory = { totalMiB: 32768, usedMiB: 8192, freeMiB: 24576 };
    const decision = planLocalRuntimeAdmission("ollama", snapshot, "workload");
    expect(decision).toMatchObject({ allowed: true, requiresConfirmation: false });
  });

  it("exposes a structured code when admission is refused", async () => {
    const { LocalRuntimeAdmissionError } = await import("../src/services/local-runtime-supervisor");
    const error = new LocalRuntimeAdmissionError({ target: "ollama", intent: "workload", allowed: true, requiresConfirmation: true,
      blockers: [], warnings: ["busy"], conflictingRuntimeIds: [], summary: "busy" });
    expect(error).toMatchObject({ code: "LOCAL_RUNTIME_ADMISSION", retryable: true, details: { runtime: "ollama", requiresConfirmation: true } });
  });
});
