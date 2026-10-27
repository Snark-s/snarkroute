import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuzhaModelGateway } from "./buzha-model-gateway";

const servers: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { for (const app of servers.splice(0)) await app.close(); });

function fixture(failed = false) {
  const app = Fastify(); servers.push(app);
  const run = vi.fn(async (_body: unknown) => failed ? {
    status: "failed", nodeResults: { chat: { error: "Provider rejected request", errorCode: "provider_failed" } }
  } : {
    runId: "run-buzha", status: "succeeded", nodeResults: { chat: {
      output: { text: "Ответ", model: "dynamic-model", actualCost: 0.002, actualUsage: { total_tokens: 40 } },
      actualProviderCostAmount: 0.002, actualProviderCostCurrency: "USD", provenance: { provider: "openrouter", model: "dynamic-model" }
    } }, economics: { baseCost: 0.002 }, costSummary: { totalActualCredits: 0.2 }
  });
  app.post("/api/routes/run", async request => run(request.body));
  registerBuzhaModelGateway(app, { models: async () => [{
    id: "openrouter:dynamic-model", name: "Dynamic", provider: "openrouter", providerModelId: "dynamic-model", pricing: { status: "fresh", source: "provider-cache", currency: "USD", pricing: { prompt: "0.1" } }
  }] });
  return { app, run };
}

describe("Buzha chat through the existing Model Gateway", () => {
  it("lists live model references and prices without credentials", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/api/system/buzha/models" });
    expect(response.json().models[0]).toMatchObject({ id: "openrouter:dynamic-model", pricing: { currency: "USD" } });
  });

  it("executes one bounded ai.text route and retains cost and provenance", async () => {
    const { app, run } = fixture();
    const response = await app.inject({ method: "POST", url: "/api/system/buzha/chat/completions", payload: {
      model: "openrouter:dynamic-model", messages: [{ role: "system", content: "system" }, { role: "user", content: "{{untrusted}}" }], stream: false,
      endpoint: "https://foreign.example", tools: [{ type: "function" }]
    } });
    expect(response.statusCode).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    const route = (run.mock.calls[0][0] as any).route;
    expect(route.nodes).toHaveLength(1);
    expect(route.nodes[0]).toMatchObject({ type: "ai.text", params: { executionProvider: "openrouter", providerModelId: "dynamic-model", max_tokens: 1024 } });
    expect(Buffer.from(route.nodes[0].params.promptBase64, "base64").toString()).toContain("{{untrusted}}");
    expect(route.nodes[0].params.tools).toBeUndefined();
    expect(route.nodes[0].params.endpoint).toBeUndefined();
    expect(response.json()).toMatchObject({ model: "dynamic-model", choices: [{ message: { content: "Ответ" } }], costs: { providerCost: 0.002, baseCost: 0.002, currency: "USD" }, provenance: { provider: "openrouter" } });
  });

  it("does not retry or fall back after a failed model request", async () => {
    const { app, run } = fixture(true);
    const response = await app.inject({ method: "POST", url: "/api/system/buzha/chat/completions", payload: { model: "openrouter:dynamic-model", messages: [{ role: "user", content: "hello" }] } });
    expect(response.statusCode).toBe(502);
    expect(run).toHaveBeenCalledTimes(1);
    expect(response.json().error).toMatchObject({ message: "Provider rejected request", retryable: false });
  });

  it.each([
    { model: "missing", messages: [{ role: "user", content: "hello" }] },
    { model: "openrouter:dynamic-model", messages: [] },
    { model: "openrouter:dynamic-model", messages: [{ role: "tool", content: "hello" }] },
    { model: "openrouter:dynamic-model", messages: [{ role: "user", content: "hello" }], stream: true }
  ])("rejects invalid requests before inference", async payload => {
    const { app, run } = fixture();
    expect((await app.inject({ method: "POST", url: "/api/system/buzha/chat/completions", payload })).statusCode).toBeGreaterThanOrEqual(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects external origins", async () => {
    const { app } = fixture();
    expect((await app.inject({ method: "GET", url: "/api/system/buzha/models", headers: { origin: "https://foreign.example" } })).statusCode).toBe(403);
  });
});
