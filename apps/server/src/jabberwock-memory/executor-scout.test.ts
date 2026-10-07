import { describe, expect, it } from "vitest";
import { reviewGateSources, selectExecutor, type ExecutorProfile } from "./executor-scout";

const profile = (model: string, changes: Partial<ExecutorProfile> = {}): ExecutorProfile => ({
  model, protocol: "json", gateVersion: "v1", testedAt: "2026-10-02",
  level1: true, level2: true, finalReview: true,
  capabilities: { read: true, mutation: true, semanticTopLevelRepair: true, sequentialSemanticRepair: true },
  metrics: { failedAttempts: 0, noProgressAttempts: 0, wallTimeMs: 100, modelCalls: 4, toolCalls: 3, productiveRepairs: 3, resourceBytes: 10 }, ...changes,
});
describe("controlled executor selection", () => {
  it("excludes stale, partial and rejected evidence", () => {
    expect(selectExecutor([profile("old", { gateVersion: "v0" }), profile("partial", { level2: false }),
      profile("rejected", { finalReview: false }), profile("unproductive", { metrics: { ...profile("x").metrics, productiveRepairs: 2 } })], "v1")).toBeNull();
  });
  it("accepts structured metric receipts while rejecting invalid ranking metrics", () => {
    const real = profile("real", { metrics: Object.assign({}, profile("x").metrics, { peakContext: [null], unsolicitedProcessCalls: [] }) });
    expect(selectExecutor([real], "v1")?.model).toBe("real");
    expect(selectExecutor([profile("invalid", { metrics: { ...real.metrics, wallTimeMs: NaN } })], "v1")).toBeNull();
  });
  it("uses failures, time, calls, footprint and stable ID deterministically", () => {
    const clean = profile("clean");
    const failed = profile("failed", { metrics: { ...clean.metrics, failedAttempts: 1, wallTimeMs: 1 } });
    expect(selectExecutor([failed, clean], "v1")?.model).toBe("clean");
    const slower = profile("slow", { metrics: { ...clean.metrics, wallTimeMs: 101 } });
    const busy = profile("busy", { metrics: { ...clean.metrics, modelCalls: 5 } });
    const larger = profile("large", { metrics: { ...clean.metrics, resourceBytes: 11 } });
    expect(selectExecutor([slower, busy, larger, clean], "v1")?.model).toBe("clean");
    expect(selectExecutor([profile("z"), profile("a", { protocol: "native" })], "v1")?.model).toBe("a");
  });
});

describe("authoritative source review", () => {
  const sources = {
    "call.ts": "export let active = false; export function setActive(value: boolean) { active = value; } setActive(true);",
    "event.ts": 'export let started = 0; export const events = new EventTarget(); export function onStarted() { started += 1; } events.addEventListener("started", onStarted);',
    "callback.ts": 'export let active = false; export const events = new EventTarget(); export function setActive(value: boolean) { active = value; } events.addEventListener("started", () => { setActive(true); });',
  };
  it("accepts preservation of actual implementations", () => expect(reviewGateSources(sources, 2)).toEqual([]));
  it("rejects the observed empty-helper false PASS", () => {
    expect(reviewGateSources({ ...sources, "call.ts": "setActive(true); export function setActive(value: boolean) { /* Existing implementation */ }" }, 1)).not.toEqual([]);
  });
  it("rejects recursive calls and appended calls instead of fixing the existing callback", () => {
    expect(reviewGateSources({ ...sources, "call.ts": sources["call.ts"].replace("active = value;", "active = value; setActive(true);") }, 2)).not.toEqual([]);
    expect(reviewGateSources({ ...sources, "callback.ts": sources["callback.ts"].replace("setActive(true);", "setActive(false); setActive(true);") }, 2)).not.toEqual([]);
  });
  it("rejects a replacement event callback and duplicate registrations", () => {
    expect(reviewGateSources({ ...sources, "event.ts": sources["event.ts"].replace(', onStarted)', ', () => {})') }, 2)).not.toEqual([]);
    expect(reviewGateSources({ ...sources, "event.ts": sources["event.ts"] + 'events.addEventListener("started", onStarted);' }, 2)).not.toEqual([]);
  });
});
