import { describe, expect, it, vi } from "vitest";
import { DECISION_PROTOCOL, DecisionDispatcher, ModelRegistry, type DecisionRequest, type ModelInfo } from "@snarkroute/core";
import { JevDecisionAdapter } from "./index";

const engine: ModelInfo = {
  id: "jev-main", providerId: "jev", title: "Jev", kind: "decision",
  protocols: [DECISION_PROTOCOL], capabilities: ["decision.select_one", "decision.classify", "decision.score"],
  availability: "available", adapterId: "jev"
};
const candidates = [{ id: "safe", value: "Safe" }, { id: "risky", value: "Risky" }];
const request = (operation: string): DecisionRequest => ({ operation, input: "Classify this", candidates });
const context = { engine, signal: new AbortController().signal };

describe("JevDecisionAdapter", () => {
  it("maps select/classify to an official Choice question", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "jev-latest", questions: { decision: { type: "choice" } } });
      expect(body.questions.decision.criteria).toEqual({ safe: "Safe", risky: "Risky" });
      return json({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "safe", probabilities: { safe: 0.82, risky: 0.18 }, confidence: 0.82 } }, usage: { input_tokens: 20, output_tokens: 3 } });
    });
    const response = await new JevDecisionAdapter({ apiKey: "secret", fetch }).execute(request("select_one"), context);
    expect(response).toMatchObject({ status: "ok", results: [{ id: "safe", score: 0.82 }], confidence: 0.82 });
    expect(fetch).toHaveBeenCalledWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }));
  });

  it("maps score and Noul responses without claiming unsupported operations", async () => {
    const scoreFetch = vi.fn(async () => json({ model: "jev-1.13.0", answers: { decision: { type: "score", score: 3, legend: {}, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, confidence: 0.7 } }, usage: {} }));
    const score = await new JevDecisionAdapter({ apiKey: "secret", fetch: scoreFetch }).execute({ operation: "score", input: "Assess", metadata: { scoreCriteria: ["bad", "okay", "good"] } }, context);
    expect(score).toMatchObject({ status: "ok", results: [{ id: "score", score: 3 }], confidence: 0.7 });

    const noulFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).questions.decision.type).toBe("noul");
      return json({ model: "jev-1.13.0", answers: { decision: { type: "noul", noul: 0.91 } }, usage: {} });
    });
    const noul = await new JevDecisionAdapter({ apiKey: "secret", fetch: noulFetch }).execute({ operation: "score", input: "Is it safe?", metadata: { jevQuestionType: "noul" } }, context);
    expect(noul).toMatchObject({ status: "ok", results: [{ id: "score", score: 0.91 }], confidence: 0.91 });
  });

  it("reports missing auth, provider errors, and malformed responses safely", async () => {
    const missing = new JevDecisionAdapter();
    await expect(missing.health(engine)).resolves.toMatchObject({ available: false, status: "missing_auth" });
    await expect(missing.execute(request("classify"), context)).resolves.toMatchObject({ status: "error", diagnostics: { reason: "missing_auth" } });

    for (const status of [401, 422, 500]) {
      const adapter = new JevDecisionAdapter({ apiKey: "secret", fetch: vi.fn(async () => json({ detail: "nope" }, status)) });
      await expect(adapter.execute(request("classify"), context)).resolves.toMatchObject({ status: "error", diagnostics: { httpStatus: status } });
    }
    const malformed = new JevDecisionAdapter({ apiKey: "secret", fetch: vi.fn(async () => json({ answers: {} })) });
    await expect(malformed.execute(request("classify"), context)).resolves.toMatchObject({ status: "error", diagnostics: { reason: "invalid_response" } });

    const network = new JevDecisionAdapter({ apiKey: "secret", fetch: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(network.execute(request("classify"), context)).resolves.toMatchObject({ status: "error", diagnostics: { reason: "network_error" } });
  });

  it("returns unsupported and lets the dispatcher enforce timeout and confidence", async () => {
    const never = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const adapter = new JevDecisionAdapter({ apiKey: "secret", fetch: never });
    expect(adapter.supports(engine, request("rank"))).toBe(false);
    await expect(adapter.execute(request("rank"), context)).resolves.toMatchObject({ status: "unsupported" });
    const timed = new DecisionDispatcher(new ModelRegistry([engine]), [adapter]);
    await expect(timed.execute(request("classify"), { timeoutMs: 5 })).resolves.toMatchObject({ status: "timeout" });

    const lowFetch = vi.fn(async () => json({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "safe", probabilities: { safe: 0.51, risky: 0.49 }, confidence: 0.51 } }, usage: {} }));
    const low = new DecisionDispatcher(new ModelRegistry([engine]), [new JevDecisionAdapter({ apiKey: "secret", fetch: lowFetch })]);
    await expect(low.execute(request("classify"), { confidenceThreshold: 0.8 })).resolves.toMatchObject({ status: "low_confidence", confidence: 0.51 });
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
