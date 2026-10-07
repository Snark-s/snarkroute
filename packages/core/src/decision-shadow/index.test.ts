import { describe, expect, it, vi } from "vitest";
import type { DecisionExecutor, DecisionRequest, DecisionResponse } from "../decision-layer";
import {
  DecisionShadowBenchmark,
  InMemoryDecisionBenchmarkStore,
  aggregateDecisionBenchmarks,
  compareDecisionResults
} from "./index";

const request: DecisionRequest = {
  operation: "select_one",
  input: { prompt: "private text" },
  candidates: [{ id: "a" }, { id: "b" }],
  metadata: { purpose: "test" }
};
const ok = (backend: string, id = "a", confidence = 0.9): DecisionResponse => ({ status: "ok", backend, results: [{ id, score: confidence }], confidence });

describe("DecisionShadowBenchmark", () => {
  it("returns production without waiting for or being changed by shadow execution", async () => {
    let release!: () => void;
    const shadowGate = new Promise<void>((resolve) => { release = resolve; });
    const production: DecisionExecutor = { execute: vi.fn(async () => ok("rules")) };
    const shadow: DecisionExecutor = { execute: vi.fn(async () => { await shadowGate; return ok("jev", "b"); }) };
    const benchmark = new DecisionShadowBenchmark(production, shadow, { enabled: true, backendIds: ["jev"], sampleRate: 1 });

    await expect(benchmark.execute(request)).resolves.toEqual(ok("rules"));
    expect(benchmark.pendingCount).toBe(1);
    release();
    await benchmark.drain();
    expect(benchmark.records[0]).toMatchObject({ productionBackend: "rules", shadowBackend: "jev", operation: "select_one", agreement: { comparable: true, agreed: false } });
  });

  it("contains shadow exceptions/timeouts and distinguishes multiple backends", async () => {
    const shadow: DecisionExecutor = {
      execute: vi.fn(async (_request, policy): Promise<DecisionResponse> => {
        const backend = policy?.engineIds?.[0];
        if (backend === "broken") throw new Error("secret crash");
        return { status: "timeout", backend, results: [] };
      })
    };
    const benchmark = new DecisionShadowBenchmark({ execute: async () => ok("rules") }, shadow, {
      enabled: true, backendIds: ["broken", "slow"], sampleRate: 1, timeoutMs: 9
    });
    await expect(benchmark.execute(request)).resolves.toEqual(ok("rules"));
    await benchmark.drain();

    expect(benchmark.records).toHaveLength(2);
    expect(benchmark.records.map((record) => [record.shadowBackend, record.shadowResult.status])).toEqual([
      ["broken", "error"], ["slow", "timeout"]
    ]);
    expect(shadow.execute).toHaveBeenCalledWith(request, expect.objectContaining({ engineIds: ["slow"], maxAttempts: 1, timeoutMs: 9 }));
  });

  it("bounds a shadow executor that ignores the requested timeout", async () => {
    const benchmark = new DecisionShadowBenchmark(
      { execute: async () => ok("rules") },
      { execute: async () => new Promise<DecisionResponse>(() => undefined) },
      { enabled: true, backendIds: ["stuck"], sampleRate: 1, timeoutMs: 5 }
    );
    await benchmark.execute(request);
    await benchmark.drain();
    expect(benchmark.records[0]).toMatchObject({ shadowBackend: "stuck", shadowResult: { status: "timeout" } });
  });

  it("supports deterministic sampling and makes zero calls while disabled", async () => {
    const shadow: DecisionExecutor = { execute: vi.fn(async () => ok("jev")) };
    const disabled = new DecisionShadowBenchmark({ execute: async () => ok("rules") }, shadow, { enabled: false, backendIds: ["jev"] });
    await disabled.execute(request);
    expect(shadow.execute).not.toHaveBeenCalled();

    const defaultZero = new DecisionShadowBenchmark({ execute: async () => ok("rules") }, shadow, { enabled: true, backendIds: ["jev"] });
    await defaultZero.execute(request);
    expect(shadow.execute).not.toHaveBeenCalled();

    const sampledOut = new DecisionShadowBenchmark({ execute: async () => ok("rules") }, shadow, { enabled: true, backendIds: ["jev"], sampleRate: 0.25, random: () => 0.9 });
    await sampledOut.execute(request);
    expect(shadow.execute).not.toHaveBeenCalled();

    const sampledIn = new DecisionShadowBenchmark({ execute: async () => ok("rules") }, shadow, { enabled: true, backendIds: ["jev"], sampleRate: 0.25, random: () => 0.1 });
    await sampledIn.execute(request);
    await sampledIn.drain();
    expect(shadow.execute).toHaveBeenCalledTimes(1);
  });

  it("stores privacy-safe fingerprints, confidence provenance, and aggregates per operation/backend", async () => {
    const store = new InMemoryDecisionBenchmarkStore(10);
    const benchmark = new DecisionShadowBenchmark(
      { execute: async () => ({ ...ok("rules"), diagnostics: { confidenceSource: "derived" } }) },
      { execute: async () => ({ ...ok("needle"), diagnostics: { confidenceSource: "provider" } }) },
      { enabled: true, backendIds: ["needle"], sampleRate: 1, store }
    );
    await benchmark.execute(request);
    await benchmark.drain();

    expect(store.records[0].requestFingerprint).toMatch(/^decision:/);
    expect(JSON.stringify(store.records[0])).not.toContain("private text");
    expect(store.records[0].confidenceProvenance).toEqual({ production: "derived", shadow: "provider" });
    expect(aggregateDecisionBenchmarks(store.records)).toEqual([
      expect.objectContaining({ shadowBackend: "needle", operation: "select_one", requests: 1, successful: 1, successRate: 1, agreements: 1, agreementRate: 1 })
    ]);
  });
});

describe("compareDecisionResults", () => {
  it("compares select/classify, score, rank, and extraction by operation", () => {
    expect(compareDecisionResults("classify", ok("a", "x"), ok("b", "x"))).toMatchObject({ agreed: true, score: 1 });
    expect(compareDecisionResults("score", { status: "ok", results: [{ id: "score", score: 0.2 }] }, { status: "ok", results: [{ id: "score", score: 0.3 }] })).toMatchObject({ comparable: true, score: 0.9 });
    expect(compareDecisionResults("rank", { status: "ok", results: [{ id: "a" }, { id: "b" }] }, { status: "ok", results: [{ id: "a" }, { id: "c" }] })).toMatchObject({ agreed: false, score: 0.5 });
    expect(compareDecisionResults("extract", { status: "ok", results: [{ id: "extraction", value: { x: 1 } }] }, { status: "ok", results: [{ id: "extraction", value: { x: 1 } }] })).toMatchObject({ agreed: true, score: 1 });
  });
});
