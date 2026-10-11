import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOptionForNodeV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { selectSemanticModelOptionV1 } from "../src/services/semantic-model-selection";
import { assertModelInvocationPolicy } from "../src/services/model-routing-policy";

afterEach(() => vi.unstubAllEnvs());

function model(provider: string, id: string, overrides: Partial<ModelOptionForNodeV1> = {}): ModelOptionForNodeV1 {
  return { id, provider, executionProvider: provider, providerModelId: id, storedModelId: id,
    displayName: id, originVendor: "test", iconKey: "generic", iconPath: "", inputTypes: ["text"],
    outputTypes: ["text"], capabilities: ["text.generate"], roles: ["generator"],
    availability: { status: "available", source: "live", configured: true }, parameters: [],
    catalogStatus: "known", nodeType: "ai.text", ...overrides };
}
const freePricing = { status: "fresh", source: "provider-live", currency: "USD", unit: "token",
  pricing: { prompt: "0", completion: "0" } } as const;

describe("central Local First / Free Available / explicit paid policy", () => {
  it("A: selects a suitable available local model before a higher ranked paid or free cloud model", async () => {
    const result = await selectSemanticModelOptionV1([
      model("polza", "paid", { metadata: { priority: 1000 } }),
      model("openrouter", "free", { pricing: freePricing, metadata: { priority: 500 } }),
      model("local_openai", "local", { metadata: { local: true, autoEligible: false } })
    ], { nodeType: "ai.text", prompt: "hello" });
    expect(result.selection?.provider).toBe("local_openai");
    expect(result.trace.policyReasons).toContain("Local First");
  });

  it("B: skips an unavailable local model and chooses a verified zero-cost route", async () => {
    const result = await selectSemanticModelOptionV1([
      model("local_openai", "offline", { availability: { status: "unavailable", source: "live", configured: true } }),
      model("polza", "paid"), model("openrouter", "free", { pricing: freePricing })
    ], { nodeType: "ai.text" });
    expect(result.selection?.providerModelId).toBe("free");
  });

  it("B: reports no permitted route when local/free cannot satisfy the task", async () => {
    const result = await selectSemanticModelOptionV1([model("polza", "paid")], { nodeType: "ai.text" });
    expect(result.status).toBe("unsupported");
    expect(result.errorCode).toBe("PAID_PERMISSION_REQUIRED");
    expect(result.selection).toBeUndefined();
  });

  it("manual pins the provider/model and cannot authorize paid use or silently change provider", async () => {
    const options = [model("local_openai", "local"), model("polza", "paid")];
    const denied = await selectSemanticModelOptionV1(options, { nodeType: "ai.text", manualModelRef: "model://polza/paid" });
    expect(denied.status).toBe("unsupported");
    expect(denied.errorCode).toBe("PAID_PERMISSION_REQUIRED");
    const allowed = await selectSemanticModelOptionV1(options, { nodeType: "ai.text", manualModelRef: "model://polza/paid", routingPolicy: { allowPaid: true } });
    expect(allowed.selection?.providerModelId).toBe("paid");
    expect(allowed.trace.selectionReason).toBe("manual_override");
  });

  it("applies task-specific local exclusion and physical exclusions on the server", async () => {
    const result = await selectSemanticModelOptionV1([
      model("local_openai", "local"), model("openrouter", "free-one", { pricing: freePricing }),
      model("openrouter", "free-two", { pricing: freePricing })
    ], { nodeType: "ai.text", routingPolicy: { localModels: "exclude", excludeModelRefs: ["model://openrouter/free-one"] } });
    expect(result.selection?.providerModelId).toBe("free-two");
  });

  it("does not claim fresh zero cost from unknown, stale, partial or misleading pricing", async () => {
    for (const pricing of [
      { ...freePricing, status: "stale" as const }, { ...freePricing, pricing: { prompt: 0 } },
      { ...freePricing, pricing: { prompt: 0, completion: "unknown" } },
      { ...freePricing, pricing: { prompt: 0, completion: 0, request: 1 } }
    ]) {
      const result = await selectSemanticModelOptionV1([model("openrouter", "candidate", { pricing })], { nodeType: "ai.text" });
      expect(result.selection).toBeUndefined();
    }
  });

  it("blocks paid invocation before a runner is called and permits only confirmed free physical routes", async () => {
    vi.stubEnv("APP_MODE", "local");
    const catalog = [model("openrouter", "free", { pricing: freePricing }), model("polza", "paid")];
    await expect(assertModelInvocationPolicy("polza", "paid", {}, "ai.text", async () => catalog)).rejects.toMatchObject({ code: "PAID_PERMISSION_REQUIRED", retryable: false });
    await expect(assertModelInvocationPolicy("openrouter", "free", {}, "ai.text", async () => catalog)).resolves.toBeUndefined();
    await expect(assertModelInvocationPolicy("polza", "paid", { routingPolicy: { allowPaid: true } }, "ai.text", async () => catalog)).resolves.toBeUndefined();
  });
});
