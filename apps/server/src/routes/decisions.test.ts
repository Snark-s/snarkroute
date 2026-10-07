import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../app";
import { createDecisionRuntimeFromEnv } from "../services/decision-runtime";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("decision.v1 server runtime", () => {
  it("executes a configured Jev backend through the provider-independent route", async () => {
    vi.stubEnv("JEV_ENABLED", "true");
    vi.stubEnv("JEV_API_KEY", "test-secret");
    vi.stubEnv("DECISION_PRODUCTION_BACKENDS", "jev-main");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.typesafe.ai/v1/systemone") {
        return json({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 } }, usage: {} });
      }
      return json({}, 404);
    }));
    const app = buildServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/decisions",
        payload: { operation: "select_one", input: "choose b", candidates: [{ id: "a" }, { id: "b" }] }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, protocol: "decision.v1", response: { status: "ok", backend: "jev-main", results: [{ id: "b" }] } });
      expect(response.body).not.toContain("test-secret");
    } finally {
      await app.close();
    }
  });

  it("keeps shadow results separate and does not change production output", async () => {
    const fetch = vi.fn(async () => json({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.8 } }, usage: {} }));
    const runtime = createDecisionRuntimeFromEnv({
      env: {
        JEV_ENABLED: "true",
        JEV_API_KEY: "test-secret",
        DECISION_PRODUCTION_BACKENDS: "semantic-rules",
        DECISION_SHADOW_ENABLED: "true",
        DECISION_SHADOW_BACKENDS: "jev-main",
        DECISION_SHADOW_SAMPLE_RATE: "1"
      },
      fetch
    });
    try {
      const result = await runtime.execute({
        operation: "select_one",
        input: "choose a",
        candidates: [{ id: "a", metadata: { keywords: ["choose a"] } }, { id: "b" }]
      });
      expect(result).toMatchObject({ status: "ok", backend: "semantic-rules", results: [{ id: "a" }] });
      await runtime.executor.drain();
      expect(runtime.benchmarkSnapshot()).toMatchObject({
        pending: 0,
        records: [{ productionBackend: "semantic-rules", shadowBackend: "jev-main", operation: "select_one" }]
      });
    } finally {
      await runtime.close();
    }
  });

  it("makes no provider calls when optional providers and shadow mode are disabled", async () => {
    const fetch = vi.fn();
    const runtime = createDecisionRuntimeFromEnv({ env: {}, fetch: fetch as typeof globalThis.fetch });
    try {
      await expect(runtime.execute({ operation: "classify", input: "code", candidates: [{ id: "code", value: "code" }] })).resolves.toMatchObject({ status: "ok", backend: "semantic-rules" });
      expect(fetch).not.toHaveBeenCalled();
      expect(runtime.benchmarkSnapshot().records).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("rejects malformed public requests before any backend call", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "POST", url: "/api/decisions", payload: { operation: "select_one" } });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
