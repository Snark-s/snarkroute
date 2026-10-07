import { describe, expect, it, vi } from "vitest";
import { DECISION_PROTOCOL, DecisionDispatcher, ModelRegistry, type DecisionRequest, type ModelInfo } from "@snarkroute/core";
import { NeedleDecisionAdapter } from "./index";

const engine: ModelInfo = {
  id: "needle-local", providerId: "needle", title: "Needle", kind: "decision",
  protocols: [DECISION_PROTOCOL], capabilities: ["decision.select_one", "decision.classify", "decision.extract"],
  availability: "available", adapterId: "needle"
};
const request: DecisionRequest = { operation: "select_one", input: "Use blue", candidates: [{ id: "red" }, { id: "blue" }] };
const context = { engine, signal: new AbortController().signal };

describe("NeedleDecisionAdapter", () => {
  it("uses the official /complete tool schema and maps a supported decision", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:7860/complete");
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0]).toMatchObject({ name: "submit_decision", parameters: { properties: { id: { enum: ["red", "blue"] } } } });
      return json({ type: "call", success: true, error: null, function_calls: [{ name: "submit_decision", arguments: { id: "blue" } }], confidence: 0.88 });
    });
    const response = await new NeedleDecisionAdapter({ baseUrl: "http://127.0.0.1:7860", fetch }).execute(request, context);
    expect(response).toMatchObject({ status: "ok", results: [{ id: "blue", score: 0.88 }], confidence: 0.88 });
  });

  it("maps empty calls to abstain and suppressed calls to low confidence", async () => {
    const empty = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch: vi.fn(async () => json({ type: "call", success: true, function_calls: [], confidence: 0.2 })) });
    await expect(empty.execute({ ...request, constraints: { allowAbstain: true } }, context)).resolves.toMatchObject({ status: "abstain", results: [] });

    const suppressed = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch: vi.fn(async () => json({ type: "call", success: true, function_calls: [], suppressed_calls: [{ name: "submit_decision", arguments: { id: "blue" } }], confidence: 0.08 })) });
    await expect(suppressed.execute(request, context)).resolves.toMatchObject({ status: "low_confidence", results: [], confidence: 0.08 });
  });

  it("supports schema extraction and rejects unsupported operations", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0].parameters.properties).toHaveProperty("invoice");
      return json({ type: "call", success: true, function_calls: [{ name: "extract_record", arguments: { invoice: "A-1" } }], confidence: null });
    });
    const adapter = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch });
    await expect(adapter.execute({ operation: "extract", input: "Invoice A-1", metadata: { schema: { type: "object", properties: { invoice: { type: "string" } }, required: ["invoice"] } } }, context)).resolves.toMatchObject({ status: "ok", results: [{ id: "extraction", value: { invoice: "A-1" } }] });
    expect(adapter.supports(engine, { operation: "score", input: "x" })).toBe(false);
    await expect(adapter.execute({ operation: "score", input: "x" }, context)).resolves.toMatchObject({ status: "unsupported" });
  });

  it("maps verified Needle tool calling without executing the tool", async () => {
    const fetch = vi.fn(async () => json({ type: "call", success: true, function_calls: [{ name: "set_light", arguments: { on: true } }], confidence: 0.93 }));
    const adapter = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch });
    const toolRequest: DecisionRequest = {
      operation: "tool_call",
      input: { query: "turn the light on" },
      metadata: { tools: [{ name: "set_light", parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } }] }
    };
    await expect(adapter.execute(toolRequest, context)).resolves.toMatchObject({ status: "ok", results: [{ id: "set_light", value: { on: true } }] });
  });

  it("reports runtime/weights/startup failure and invalid output without leaking details", async () => {
    const unavailable = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch: vi.fn(async () => json({ error: "weights missing at C:/secret/model.cact" }, 503)) });
    await expect(unavailable.health(engine)).resolves.toMatchObject({ available: false, status: "runtime_unavailable" });

    const crashed = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch: vi.fn(async () => { throw new Error("spawn failed C:/secret"); }) });
    await expect(crashed.health(engine)).resolves.toMatchObject({ available: false, status: "runtime_unavailable" });

    const invalid = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch: vi.fn(async () => json({ success: true, function_calls: [{ bad: true }] })) });
    await expect(invalid.execute(request, context)).resolves.toMatchObject({ status: "error", diagnostics: { reason: "invalid_response" } });
  });

  it("is time-bounded by the dispatcher and resets cleanly on shutdown", async () => {
    const never = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/model")
      ? Promise.resolve(json({ model: "needle3" }))
      : new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("crashed")))));
    const adapter = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch: never as typeof fetch });
    const dispatcher = new DecisionDispatcher(new ModelRegistry([engine]), [adapter]);
    await expect(dispatcher.execute(request, { timeoutMs: 5 })).resolves.toMatchObject({ status: "timeout" });

    const resetFetch = vi.fn(async () => json({ ok: true }));
    const closable = new NeedleDecisionAdapter({ baseUrl: "http://needle", fetch: resetFetch });
    await expect(closable.close()).resolves.toBeUndefined();
    expect(resetFetch).toHaveBeenCalledWith("http://needle/reset", expect.objectContaining({ method: "POST" }));
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
