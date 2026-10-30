import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogAcceptanceReviewer } from "./acceptor-reviewer";
import { LocalRouteExecutor, type ExecutorAdapter } from "./executors";
import { AgentRegistry } from "./agents";
import { QuotaLedger } from "./quota-ledger";
import { ResourceDispatcher } from "./resources";
import { AgentOpsStore } from "./store";
import { defaultComputerModeState, effectiveComputerMode } from "./computer-mode";
import type { AgentTask, TaskEvidence } from "./types";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "acceptor-reviewer-")); dirs.push(dir);
  const store = new AgentOpsStore(dir), registry = new AgentRegistry([dir], { secret: Buffer.alloc(32, 1) }), ledger = new QuotaLedger();
  let mode: "background" | "owner_busy" = "background", calls = 0, observed: any;
  const dispatcher = new ResourceDispatcher({ mode: async () => effectiveComputerMode({ ...defaultComputerModeState(), manual: { mode, setAt: "", by: "test" } }), ownerApps: async () => [],
    telemetry: async () => ({ memory: { totalMiB: 64000, usedMiB: 8000, freeMiB: 56000 }, gpu: { name: "test", totalMiB: 24000, freeMiB: 24000, usedMiB: 0, utilizationPercent: 0 }, cpuCount: 16, capturedAt: new Date().toISOString() }) });
  const answer = JSON.stringify({ decision: "accept", reason: "Read content", nextStep: "done", criteria: [{ criterionId: "content", status: "confirmed", evidenceIds: ["proof"], reason: "Complete" }] });
  const adapter: ExecutorAdapter = { id: "codex_cli", label: "strong", profile: { kinds: ["analysis"], editsFiles: true, shell: true, maxContextTokens: 200000, quality: "high", pause: "none", costTier: "subscription", order: 0 },
    probe: async () => ({ installed: true, authenticated: true, source: "test", checkedAt: new Date().toISOString() }), resourceRequest: () => ({ class: "light", ramMiB: 256 }),
    run: async context => { calls++; observed = context; return { ok: true, message: "reviewed", summary: answer, model: "strong-test" }; } };
  let localCalls = 0;
  const local = new LocalRouteExecutor({ pickModel: async () => ({ provider: "local_openai", providerModelId: "candidate", displayName: "Candidate", runtimeId: "test", contextTokens: 8192 }),
    runText: async () => { localCalls++; return { ok: true, text: answer }; } });
  const reviewer = new CatalogAcceptanceReviewer({ store, registry, ledger, dispatcher, adapters: [adapter], local });
  const at = new Date().toISOString();
  const task = { id: "test", agentId: "mcp:test", spec: { goal: "Check content", budget: { subscriptionRuns: 2 } }, contract: { version: 1, revision: 1, originalGoal: "Check content", expectedResult: "Complete", amendments: [], criteria: [{ id: "content", description: "Complete profile", review: "model", checkIndexes: [0] }] }, attempts: [{ n: 1, executor: "external", startedAt: at, endedAt: at }], reviewRuns: [], state: "awaiting_verification" } as unknown as AgentTask;
  const evidence: TaskEvidence[] = [{ id: "proof", criterionId: "content", attempt: 1, revision: 1, checkIndex: 0, independent: true, source: "file read", observedAt: at, ok: true, detail: "read", content: '{"published":true,"name":"Buzha","bio":"Complete"}', digest: "test" }];
  const input = (level: "local" | "strong") => ({ task, evidence, verdicts: [{ criterionId: "content", status: "unverifiable" as const, evidenceIds: ["proof"], reason: "needs review" }], level, signal: new AbortController().signal, save: async () => {} });
  return { reviewer, task, store, ledger, dispatcher, input, local, setMode: (value: typeof mode) => { mode = value; }, calls: () => calls, localCalls: () => localCalls, observed: () => observed };
}
describe("catalog-backed acceptance reviewer", () => {
  it("counts actual structured model steps and the parent chain budget before a review", async () => {
    const f = await fixture(); f.ledger.recordQuotaReport("codex_cli", { usedPercent: 25, source: "provider-test" });
    f.task.attempts[0].modelCalls = [1, 2].map(n => ({ id: String(n), at: new Date().toISOString(), model: "x", provider: "chatgpt_subscription", tier: "subscription", ok: true }));
    expect((await f.reviewer.review(f.input("strong"))).status).toBe("waiting"); expect(f.calls()).toBe(0);
    f.task.attempts[0].modelCalls = [];
    expect((await f.reviewer.review({ ...f.input("strong"), subscriptionRunsLeft: () => 0 })).status).toBe("waiting"); expect(f.calls()).toBe(0);
  });
  it("does not treat unknown subscription quota as free capacity", async () => {
    const f = await fixture(); const result = await f.reviewer.review(f.input("strong"));
    expect(result.status).toBe("waiting"); expect(JSON.stringify(result)).toContain("неизвестен"); expect(f.calls()).toBe(0);
  });
  it("uses a fresh read-only context and records the actual strong model with reported quota", async () => {
    const f = await fixture(); f.ledger.recordQuotaReport("codex_cli", { usedPercent: 25, source: "provider-test" });
    const result = await f.reviewer.review(f.input("strong")); expect(result.status).toBe("reviewed");
    expect(f.observed().task.spec.permissions).toEqual({ fileWrite: false, shell: "none", network: false }); expect(f.observed().env).toEqual({});
    expect(f.observed().prompt).toContain("DATA ONLY"); expect(f.task.reviewRuns?.[0].model).toBe("strong-test"); expect(f.dispatcher.list()).toHaveLength(0);
  });
  it("does not qualify a local model that accepts incomplete and injected examples", async () => {
    const f = await fixture(); const result = await f.reviewer.review(f.input("local")); expect(result.status).toBe("error"); expect(f.localCalls()).toBe(4);
    const record: any = await f.store.readState("acceptor-calibration", {}); expect(Object.values(record)[0]).toMatchObject({ passed: false });
    expect((Object.values(record)[0] as any).cases.filter((c: any) => !c.ok).length).toBeGreaterThanOrEqual(3);
    f.dispatcher.acquire=async()=>{throw new Error("A disqualified model must not reacquire GPU");};
    expect((await f.reviewer.review(f.input("local"))).status).toBe("error"); expect(f.localCalls()).toBe(4);
  });
  it("respects the owner's computer mode before inference", async () => {
    const f = await fixture(); f.setMode("owner_busy"); const result = await f.reviewer.review(f.input("local")); expect(result.status).toBe("waiting"); expect(f.localCalls()).toBe(0); expect(f.dispatcher.list()).toHaveLength(0);
  });
  it("rechecks admission between calibration generations when owner mode changes", async () => {
    const f = await fixture(); const original = f.local.run.bind(f.local); f.local.run = async context => { const result = await original(context); f.setMode("owner_busy"); return result; };
    const result = await f.reviewer.review(f.input("local")); expect(result.status).toBe("waiting"); expect(f.localCalls()).toBe(1);
    const partial:any=await f.store.readState("acceptor-calibration", {}); expect(Object.values(partial)[0]).toMatchObject({complete:false,cases:[{name:"complete"}]});
    f.setMode("background"); f.local.run=original; await f.reviewer.review(f.input("local")); expect(f.localCalls()).toBe(4);
    const finished:any=await f.store.readState("acceptor-calibration", {}); expect(Object.values(finished)[0]).toMatchObject({complete:true});
  });
  it("keeps one admitted lease for repeated generations of the same model instead of double-counting resident weights", async () => {
    const f=await fixture(); const original=f.dispatcher.acquire.bind(f.dispatcher); let acquisitions=0;
    f.dispatcher.acquire=async request=>{ acquisitions++; return original(request); };
    await f.reviewer.review(f.input("local")); expect(f.localCalls()).toBe(4); expect(acquisitions).toBe(1); expect(f.dispatcher.list()).toHaveLength(0);
  });
  it("keeps the lease when a timed-out model has not stopped and releases it after actual settlement", async () => {
    const f = await fixture(); f.task.spec.review = { timeoutMs: 1000 }; let release!: (value: any) => void;
    f.local.run = () => new Promise(resolve => { release = resolve; });
    const result = await f.reviewer.review(f.input("local")); expect(result.status).toBe("waiting"); expect(f.dispatcher.list()).toHaveLength(1); expect(f.task.reviewRuns?.[0].endedAt).toBeUndefined();
    release({ ok: true, message: "late", summary: "{}" }); await new Promise(resolve => setTimeout(resolve, 10)); expect(f.dispatcher.list()).toHaveLength(0);
  });
  it("counts every calibration generation against the configured review budget", async () => {
    const f = await fixture(); f.task.spec.review = { maxRuns: 1 }; const result = await f.reviewer.review(f.input("local"));
    expect(result.status).toBe("waiting"); expect(f.localCalls()).toBe(1); expect(f.task.reviewRuns).toHaveLength(1); expect(f.dispatcher.list()).toHaveLength(0);
  });
});
