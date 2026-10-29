import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "./agents";
import { defaultComputerModeState, effectiveComputerMode, ownerClock, ruleMatches, type ComputerModeState } from "./computer-mode";
import { claudeAllowedTools, type ExecutorAdapter, type ExecutorOutcome, type ExecutorProfile, type ExecutorRunContext } from "./executors";
import { LockManager, lockKeysOverlap, workspaceLockKey } from "./locks";
import { QuotaLedger } from "./quota-ledger";
import { ResourceDispatcher, type Telemetry } from "./resources";
import { rankExecutors } from "./router";
import { AgentOpsStore } from "./store";
import { AgentOpsError, AgentTaskService } from "./tasks";
import type { AgentPolicy, TaskSpec } from "./types";
import { codexAgentExecArgs } from "../services/codex-cli";

const GiB = 1024;
const telemetry = (usedMiB = 2 * GiB, totalMiB = 16 * GiB): Telemetry => ({
  gpu: { name: "RTX", totalMiB, usedMiB, freeMiB: totalMiB - usedMiB, utilizationPercent: 5 },
  memory: { totalMiB: 64 * GiB, usedMiB: 16 * GiB, freeMiB: 48 * GiB }, cpuCount: 16, capturedAt: new Date().toISOString()
});

describe("computer mode", () => {
  it("reads the clock in Europe/Moscow regardless of the host zone", () => {
    // 2026-10-29 21:30 UTC is Friday 00:30 in Moscow (UTC+3).
    expect(ownerClock(new Date("2026-10-29T21:30:00Z"))).toMatchObject({ day: 5, minutes: 30 });
  });

  it("defaults to the conservative background mode without a schedule", () => {
    expect(effectiveComputerMode(defaultComputerModeState(), new Date("2026-10-30T02:00:00Z"))).toMatchObject({ mode: "background", source: "default" });
  });

  it("applies schedule windows across midnight and lets manual mode win", () => {
    const state: ComputerModeState = { ...defaultComputerModeState(), schedule: [
      { id: "night", days: [4], from: "23:00", to: "07:00", mode: "free" },
      { id: "day", days: [1, 2, 3, 4, 5], from: "10:00", to: "19:00", mode: "owner_busy" }
    ] };
    expect(ruleMatches(state.schedule[0], { day: 5, minutes: 6 * 60 })).toBe(true);
    // Friday 03:00 MSK = Friday 00:00 UTC: inside Thursday's night window.
    expect(effectiveComputerMode(state, new Date("2026-10-30T00:00:00Z"))).toMatchObject({ mode: "free", source: "schedule", ruleId: "night" });
    // Thursday 12:00 MSK = 09:00 UTC.
    expect(effectiveComputerMode(state, new Date("2026-10-29T09:00:00Z"))).toMatchObject({ mode: "owner_busy", source: "schedule" });
    // Friday 08:00 MSK: no window -> background, never "night means free".
    expect(effectiveComputerMode(state, new Date("2026-10-30T05:00:00Z"))).toMatchObject({ mode: "background", source: "default" });
    const manual = { ...state, manual: { mode: "owner_busy" as const, setAt: "2026-10-29T00:00:00Z", by: "owner", until: "2026-10-30T01:00:00Z" } };
    expect(effectiveComputerMode(manual, new Date("2026-10-30T00:00:00Z"))).toMatchObject({ mode: "owner_busy", source: "manual" });
    expect(effectiveComputerMode(manual, new Date("2026-10-30T01:30:00Z"))).toMatchObject({ mode: "free", source: "schedule" });
  });
});

describe("resource dispatcher", () => {
  const modeOf = (mode: "owner_busy" | "background" | "free") => async () => effectiveComputerMode({ ...defaultComputerModeState(), manual: { mode, setAt: "", by: "t" } });

  it("never lets two agents count the same free VRAM", async () => {
    const dispatcher = new ResourceDispatcher({ telemetry: async () => telemetry(2 * GiB), mode: modeOf("free"), ownerApps: async () => [] });
    const request = { agentId: "a", purpose: "p", class: "light" as const, origin: "agent" as const, vramMiB: 9 * GiB };
    const [first, second] = await Promise.all([dispatcher.acquire({ ...request, holder: "one" }), dispatcher.acquire({ ...request, holder: "two" })]);
    expect([first.granted, second.granted].sort()).toEqual([false, true]);
    const denied = [first, second].find(decision => !decision.granted);
    expect(denied && !denied.granted && denied.reason).toMatch(/VRAM/);
  });

  it("keeps heavy agent work out while the owner needs the computer, but lets the owner run", async () => {
    const dispatcher = new ResourceDispatcher({ telemetry: async () => telemetry(), mode: modeOf("owner_busy"), ownerApps: async () => [] });
    const agent = await dispatcher.acquire({ holder: "t", agentId: "a", purpose: "flux", class: "heavy", origin: "agent", vramMiB: 4 * GiB });
    expect(agent).toMatchObject({ granted: false, waitFor: "window" });
    const owner = await dispatcher.acquire({ holder: "o", agentId: "owner", purpose: "flux", class: "heavy", origin: "owner", vramMiB: 4 * GiB });
    expect(owner.granted).toBe(true);
  });

  it("holds background heavy work while the owner's Blender runs", async () => {
    const dispatcher = new ResourceDispatcher({ telemetry: async () => telemetry(), mode: modeOf("background"), ownerApps: async () => ["blender"] });
    expect(await dispatcher.acquire({ holder: "t", agentId: "a", purpose: "x", class: "heavy", origin: "agent", vramMiB: GiB })).toMatchObject({ granted: false, waitFor: "window" });
  });

  it("verifies an expired lease before freeing it and learns from measured peaks", async () => {
    let now = 1_000_000;
    let alive = true;
    const dispatcher = new ResourceDispatcher({ telemetry: async () => telemetry(), mode: modeOf("free"), ownerApps: async () => [], now: () => now, stillActive: async () => alive, declaredVramMiB: () => 10 * GiB });
    const decision = await dispatcher.acquire({ holder: "t", agentId: "a", purpose: "x", class: "heavy", origin: "agent", runtimeId: "flux3", ttlMs: 1000 });
    expect(decision.granted && decision.lease.estimateSource).toBe("declared");
    now += 5000;
    await dispatcher.expireStale();
    expect(dispatcher.list()).toHaveLength(1);
    dispatcher.observe(telemetry(2 * GiB + 6 * GiB));
    alive = false;
    now += 5000;
    await dispatcher.expireStale();
    expect(dispatcher.list()).toHaveLength(0);
    const again = await dispatcher.acquire({ holder: "t2", agentId: "a", purpose: "x", class: "heavy", origin: "agent", runtimeId: "flux3" });
    expect(again.granted).toBe(true);
    // Expired-unverified releases do not record a measurement; an explicit release does.
    if (again.granted) { dispatcher.observe(telemetry(2 * GiB + 7 * GiB)); dispatcher.release(again.lease.id); }
    const third = await dispatcher.acquire({ holder: "t3", agentId: "a", purpose: "x", class: "heavy", origin: "agent", runtimeId: "flux3" });
    expect(third.granted && third.lease.estimateSource).toBe("measured");
    expect(third.granted && third.lease.vramMiB).toBe(Math.round(7 * GiB * 1.15));
  });
});

describe("quota ledger", () => {
  it("separates quota, rate limits and auth; expires limits and stale reports", () => {
    let now = Date.parse("2026-10-29T10:00:00Z");
    const ledger = new QuotaLedger({ now: () => now });
    expect(ledger.view("codex_cli").quota.state).toBe("unknown");
    ledger.recordFailure("codex_cli", { class: "quota_exhausted", message: "limit", resetsAt: "2026-10-29T12:00:00Z", source: "test" });
    expect(ledger.availability("codex_cli", "subscription")).toMatchObject({ usable: false, retryAt: "2026-10-29T12:00:00Z" });
    ledger.recordFailure("claude_code", { class: "auth", message: "not logged in", source: "test" });
    expect(ledger.availability("claude_code", "subscription")).toMatchObject({ usable: false, permanent: true });
    now = Date.parse("2026-10-29T12:00:01Z");
    expect(ledger.availability("codex_cli", "subscription").usable).toBe(true);
    ledger.recordQuotaReport("codex_cli", { usedPercent: 40, source: "session" });
    expect(ledger.view("codex_cli").quota.state).toBe("reported");
    now += 31 * 60_000;
    expect(ledger.view("codex_cli")).toMatchObject({ quota: { state: "unknown" }, quotaStale: true });
  });

  it("caps concurrent subscription runs across executors and chat turns", () => {
    const ledger = new QuotaLedger();
    ledger.limits.maxConcurrentSubscriptionRuns = 2;
    ledger.registerExternalActivity("claude_code", () => 1);
    ledger.begin("codex_cli");
    expect(ledger.availability("claude_code", "subscription")).toMatchObject({ usable: false });
    expect(ledger.availability("local_route", "local").usable).toBe(true);
  });
});

describe("locks", () => {
  it("treats nested paths as conflicting and is all-or-nothing", () => {
    expect(lockKeysOverlap(workspaceLockKey("C:/repo"), workspaceLockKey("C:/repo/sub"))).toBe(true);
    expect(lockKeysOverlap(workspaceLockKey("C:/repo"), workspaceLockKey("C:/repo2"))).toBe(false);
    const locks = new LockManager();
    expect(locks.tryAcquire([workspaceLockKey("C:/repo")], { taskId: "a", agentId: "x" }).ok).toBe(true);
    const second = locks.tryAcquire(["service:git", workspaceLockKey("C:/repo/sub")], { taskId: "b", agentId: "y" });
    expect(second.ok).toBe(false);
    expect(locks.list().some(lock => lock.key === "service:git")).toBe(false);
  });

  it("keeps locks of a crashed owner as suspect instead of granting a second owner", () => {
    const first = new LockManager();
    first.tryAcquire([workspaceLockKey("C:/repo")], { taskId: "a", agentId: "x" });
    const restarted = new LockManager();
    restarted.restore({ locks: first.list(), fencing: 1 });
    const attempt = restarted.tryAcquire([workspaceLockKey("C:/repo")], { taskId: "b", agentId: "y" });
    expect(attempt.ok).toBe(false);
    expect(!attempt.ok && attempt.conflicts[0].state).toBe("suspect");
  });
});

const policy: AgentPolicy = { id: "agent", allowedExecutors: ["local_route", "codex_cli", "claude_code"], maxDelegationDepth: 3, chainBudget: { tasks: 8, wallMinutes: 180, subscriptionRuns: 6 }, workspaceRoots: [], maxPriority: 70, canSetComputerMode: false, canUseHeavyGpu: true, dailyTaskLimit: 30 };

class FakeExecutor implements ExecutorAdapter {
  runs = 0;
  active = 0;
  maxActive = 0;
  probeResult = { installed: true, authenticated: true as boolean | null };
  next: Array<(context: ExecutorRunContext) => Promise<ExecutorOutcome>> = [];
  constructor(readonly id: string, readonly label: string, readonly profile: ExecutorProfile, private readonly heavy = false) {}
  async probe() { return { ...this.probeResult, checkedAt: new Date().toISOString(), source: "fake", runtimeId: this.heavy ? "ollama" : undefined }; }
  resourceRequest() { return this.heavy ? { class: "heavy" as const, runtimeId: "ollama", vramMiB: 6 * GiB } : { class: "light" as const, cpuSlots: 1 }; }
  async run(context: ExecutorRunContext): Promise<ExecutorOutcome> {
    this.runs += 1; this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const step = this.next.shift();
      if (step) return await step(context);
      if (context.workdir) await writeFile(join(context.workdir, "result.txt"), `done by ${this.id}`, "utf8");
      return { ok: true, message: "ok", summary: `${this.id} finished` };
    } finally { this.active -= 1; }
  }
}

const profile = (tier: "local" | "subscription", order: number, kinds: ExecutorProfile["kinds"], edits: boolean): ExecutorProfile =>
  ({ kinds, editsFiles: edits, shell: edits, maxContextTokens: tier === "local" ? 8192 : 200_000, quality: tier === "local" ? "normal" : "high", pause: tier === "local" ? "stage_boundary" : "none", costTier: tier, order });

describe("executor routing", () => {
  const adapters = [
    new FakeExecutor("local_route", "local", profile("local", 0, ["text", "analysis"], false), true),
    new FakeExecutor("codex_cli", "codex", profile("subscription", 1, ["code_edit", "text", "analysis"], true)),
    new FakeExecutor("claude_code", "claude", profile("subscription", 2, ["code_edit", "text", "analysis"], true))
  ];
  const probes = new Map(adapters.map(adapter => [adapter.id, { installed: true, authenticated: true, checkedAt: "", source: "" }]));
  it("does not pick the free local model for code edits", () => {
    const ranked = rankExecutors({ spec: { goal: "fix the bug", workspace: "C:/repo", checks: [{ type: "command", command: "node" }] }, policy, adapters, probes });
    expect(ranked[0].executorId).toBe("codex_cli");
    expect(ranked.find(candidate => candidate.executorId === "local_route")?.suitable).toBe(false);
  });
  it("prefers the local model for a plain text task that fits", () => {
    expect(rankExecutors({ spec: { goal: "summarize this paragraph" }, policy, adapters, probes })[0].executorId).toBe("local_route");
  });
  it("skips local when the quality required is higher than it offers", () => {
    expect(rankExecutors({ spec: { goal: "write an essay", requirements: { quality: "high" } }, policy, adapters, probes })[0].executorId).toBe("codex_cli");
  });
});

describe("delegated task queue", () => {
  const directories: string[] = [];
  const services: AgentTaskService[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) { await service.drain(); service.close(); }
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function setup(options: { mode?: "owner_busy" | "background" | "free"; directory?: string; alive?: boolean; ledger?: QuotaLedger; adapters?: FakeExecutor[]; locks?: LockManager } = {}) {
    const directory = options.directory ?? await mkdtemp(join(tmpdir(), "agent-ops-"));
    if (!options.directory) directories.push(directory);
    const workspace = join(directory, "sandbox", "project");
    await mkdir(workspace, { recursive: true });
    const store = new AgentOpsStore(join(directory, "data"));
    const modeState = { ...defaultComputerModeState(), manual: options.mode ? { mode: options.mode, setAt: "", by: "t" } : undefined };
    const mode = async () => effectiveComputerMode(modeState);
    const adapters = options.adapters ?? [
      new FakeExecutor("local_route", "local", profile("local", 0, ["text", "analysis"], false), true),
      new FakeExecutor("codex_cli", "codex", profile("subscription", 1, ["code_edit", "text", "analysis"], true)),
      new FakeExecutor("claude_code", "claude", profile("subscription", 2, ["code_edit", "text", "analysis"], true))
    ];
    let tasksRef: AgentTaskService | undefined;
    const dispatcher = new ResourceDispatcher({ telemetry: async () => telemetry(), mode, ownerApps: async () => [],
      stillActive: async lease => { const task = tasksRef?.get(lease.holder); return Boolean(task && task.state === "running"); } });
    const registry = new AgentRegistry([join(directory, "sandbox")], { secret: Buffer.alloc(32, 7) });
    const ledger = options.ledger ?? new QuotaLedger();
    const locks = options.locks ?? new LockManager();
    const service = new AgentTaskService({ store, registry, ledger, locks, dispatcher, adapters, mode, apiUrl: "http://127.0.0.1:1", worktreeRoot: join(directory, "worktrees"), tickMs: 60_000,
      workspace: options.alive === undefined ? undefined : { alive: async () => options.alive! } });
    tasksRef = service;
    await service.init();
    services.push(service);
    const agent = registry.mcpClient("fresh-test-agent");
    return { directory, workspace, service, adapters, agent, registry, ledger, locks, modeState, dispatcher };
  }

  async function until(service: AgentTaskService, id: string, states: string[], timeoutMs = 5000) {
    const started = Date.now();
    for (;;) {
      service.kick();
      await service.settle();
      const task = service.get(id)!;
      if (states.includes(task.state)) return task;
      if (Date.now() - started > timeoutMs) throw new Error(`task ${id} stuck in ${task.state}: ${task.reason}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  const codeTask = (workspace: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
    goal: "Create result.txt", workspace, checks: [{ type: "file_contains", path: "result.txt", text: "done by" }], idempotencyKey: undefined, ...extra
  });

  it("routes a code task to Codex, checks files itself and reports verified", async () => {
    const { service, workspace, agent, adapters } = await setup();
    const { task } = await service.submit(agent, codeTask(workspace));
    const done = await until(service, task.id, ["verified", "failed", "blocked"]);
    expect(done.state).toBe("verified");
    expect(done.executor).toBe("codex_cli");
    expect(done.result?.changedFiles).toContain("result.txt");
    expect(done.result?.checks[0].ok).toBe(true);
    expect(adapters[1].runs).toBe(1);
  });

  it("fails verification when the executor only claims success", async () => {
    const { service, workspace, agent, adapters } = await setup();
    adapters[1].next.push(async () => ({ ok: true, message: "ok", summary: "All done, tests pass!" }));
    const { task } = await service.submit(agent, codeTask(workspace));
    const done = await until(service, task.id, ["verified", "failed"]);
    expect(done.state).toBe("failed");
    expect(done.reason).toMatch(/Проверка не прошла/);
  });

  it("returns the same task for a repeated idempotency key and rejects a duplicate goal", async () => {
    const { service, workspace, agent } = await setup({ mode: "owner_busy" });
    const first = await service.submit(agent, codeTask(workspace, { idempotencyKey: "k1", executor: "local_route", requirements: { kind: "text" }, checks: [] }));
    const again = await service.submit(agent, codeTask(workspace, { idempotencyKey: "k1", executor: "local_route", requirements: { kind: "text" }, checks: [] }));
    expect(again.deduplicated).toBe(true);
    expect(again.task.id).toBe(first.task.id);
    await expect(service.submit(agent, codeTask(workspace, { requirements: { kind: "text" }, checks: [] }))).rejects.toMatchObject({ code: "DUPLICATE_TASK" });
  });

  it("never runs two tasks in one working copy at the same time", async () => {
    const { service, workspace, agent, adapters } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    adapters[1].next.push(async context => { await gate; await writeFile(join(context.workdir!, "result.txt"), "done by first"); return { ok: true, message: "ok" }; });
    adapters[2].next.push(async context => { await writeFile(join(context.workdir!, "result.txt"), "done by second"); return { ok: true, message: "ok" }; });
    const first = await service.submit(agent, codeTask(workspace, { goal: "first edit" }));
    await until(service, first.task.id, ["running"]);
    const second = await service.submit(agent, codeTask(workspace, { goal: "second edit", executor: "claude_code" }));
    const waiting = await until(service, second.task.id, ["waiting_resources"]);
    expect(waiting.reason).toMatch(/Рабочая копия занята/);
    release();
    await until(service, first.task.id, ["verified"]);
    await until(service, second.task.id, ["verified"]);
    expect(adapters[1].maxActive + adapters[2].maxActive).toBe(2);
  });

  it("lets only one of two heavy GPU tasks run", async () => {
    const { service, agent, adapters } = await setup({ mode: "free" });
    let release!: () => void;
    adapters[0].next.push(() => new Promise(resolve => { release = () => resolve({ ok: true, message: "ok", summary: "a", artifactText: "a" }); }));
    const a = await service.submit(agent, { goal: "summarize text A", executor: "local_route" });
    await until(service, a.task.id, ["running"]);
    const b = await service.submit(agent, { goal: "summarize text B", executor: "local_route", allowedExecutors: ["local_route"] });
    const waiting = await until(service, b.task.id, ["waiting_resources", "waiting_executor"]);
    expect(waiting.reason).toMatch(/занят|Тяжёлый слот|параллельных/);
    expect(adapters[0].active).toBe(1);
    release();
    await until(service, a.task.id, ["awaiting_verification"]);
    await until(service, b.task.id, ["awaiting_verification"]);
    expect(adapters[0].maxActive).toBe(1);
  });

  it("stops handing out heavy stages when the owner needs the computer", async () => {
    const { service, agent, modeState, adapters } = await setup({ mode: "owner_busy" });
    const heavy = await service.submit(agent, { goal: "summarize the report", executor: "local_route", allowedExecutors: ["local_route"] });
    const waiting = await until(service, heavy.task.id, ["waiting_window"]);
    expect(waiting.reason).toMatch(/Компьютер нужен мне/);
    expect(adapters[0].runs).toBe(0);
    modeState.manual = { mode: "free", setAt: "", by: "owner" };
    await until(service, heavy.task.id, ["awaiting_verification"]);
  });

  it("falls back to Claude after a Codex quota limit without running the work twice", async () => {
    const { service, workspace, agent, adapters, ledger } = await setup();
    adapters[1].next.push(async () => ({ ok: false, failureClass: "quota_exhausted", message: "You've hit your usage limit", resetsAt: new Date(Date.now() + 3_600_000).toISOString() }));
    const { task } = await service.submit(agent, codeTask(workspace));
    const done = await until(service, task.id, ["verified", "failed", "blocked"]);
    expect(done.state).toBe("verified");
    expect(done.attempts.map(attempt => [attempt.executor, attempt.outcome])).toEqual([["codex_cli", "failed"], ["claude_code", "succeeded"]]);
    expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("done by claude_code");
    expect(ledger.view("codex_cli").quota.state).toBe("exhausted");
  });

  it("blocks instead of re-running when a limited attempt left partial changes", async () => {
    const { service, workspace, agent, adapters } = await setup();
    adapters[1].next.push(async context => { await writeFile(join(context.workdir!, "half.txt"), "partial"); return { ok: false, failureClass: "quota_exhausted", message: "limit" }; });
    const { task } = await service.submit(agent, codeTask(workspace));
    const blocked = await until(service, task.id, ["blocked", "verified"]);
    expect(blocked.state).toBe("blocked");
    expect(blocked.reason).toMatch(/частичных изменений/);
    expect(adapters[2].runs).toBe(0);
    await service.resolve(task.id, agent, "continue");
    expect((await until(service, task.id, ["verified"])).executor).toBe("claude_code");
  });

  it("waits honestly when every executor is limited and blocks when none can ever run", async () => {
    const { service, workspace, agent, ledger, adapters } = await setup();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    ledger.recordFailure("codex_cli", { class: "quota_exhausted", message: "limit", resetsAt: later, source: "sim", simulated: true });
    ledger.recordFailure("claude_code", { class: "rate_limited", message: "429", resetsAt: later, source: "sim", simulated: true });
    const { task } = await service.submit(agent, codeTask(workspace));
    const waiting = await until(service, task.id, ["waiting_executor"]);
    expect(waiting.reason).toMatch(/лимит подписки исчерпан.*симуляция/);
    adapters[1].probeResult = { installed: false, authenticated: false };
    adapters[2].probeResult = { installed: true, authenticated: false };
    await service.refreshExecutorProbes(true);
    expect((await until(service, task.id, ["blocked"])).reason).toMatch(/недоступны/);
    expect(adapters[1].runs + adapters[2].runs).toBe(0);
  });

  it("refuses cyclic delegation, too deep chains and exhausted chain budgets", async () => {
    const { service, workspace, agent, registry } = await setup({ mode: "owner_busy" });
    const root = await service.submit(agent, { goal: "root goal", workspace, executor: "local_route", requirements: { kind: "text" } });
    const child = registry.taskAgent(root.task.id, "child");
    await expect(service.submit(child, { goal: "root goal", workspace, requirements: { kind: "text" } })).rejects.toMatchObject({ code: "DELEGATION_CYCLE" });
    let parent = root.task;
    for (let depth = 2; depth <= 3; depth += 1) parent = (await service.submit(registry.taskAgent(parent.id, "c"), { goal: `level ${depth}`, workspace, requirements: { kind: "text" } })).task;
    await expect(service.submit(registry.taskAgent(parent.id, "c"), { goal: "level 4", workspace, requirements: { kind: "text" } })).rejects.toMatchObject({ code: "DELEGATION_TOO_DEEP" });
    for (let index = 0; index < 5; index += 1) await service.submit(registry.taskAgent(root.task.id, "c"), { goal: `sibling ${index}`, workspace, requirements: { kind: "text" } });
    await expect(service.submit(registry.taskAgent(root.task.id, "c"), { goal: "one too many", workspace, requirements: { kind: "text" } })).rejects.toMatchObject({ code: "CHAIN_BUDGET_EXCEEDED" });
  });

  it("refuses a workspace outside the agent's allowed roots", async () => {
    const { service, agent } = await setup();
    await expect(service.submit(agent, { goal: "x", workspace: tmpdir() })).rejects.toBeInstanceOf(AgentOpsError);
  });

  it("keeps the queue across a restart and never reruns a live or finished execution blindly", async () => {
    const first = await setup();
    let release!: () => void;
    first.adapters[1].next.push(context => new Promise(resolve => {
      context.onPid(424242);
      release = () => resolve({ ok: true, message: "late" });
    }));
    const running = await first.service.submit(first.agent, codeTask(first.workspace, { goal: "survive restart" }));
    await until(first.service, running.task.id, ["running"]);
    const queued = await first.service.submit(first.agent, { goal: "queued text", requirements: { kind: "text" }, executor: "local_route" });
    await first.service.drain();
    first.service.close();

    // Executor process still alive after the restart: wait for it, no second run.
    const alive = await setup({ directory: first.directory, alive: true, locks: restoreLocks(first.locks) });
    expect(alive.service.get(running.task.id)?.state).toBe("unknown_outcome");
    expect(["queued", "waiting_window", "waiting_resources", "running", "awaiting_verification"]).toContain(alive.service.get(queued.task.id)?.state);
    await alive.service.drain();
    alive.service.close();

    // The process is gone and it had written the file: the checks decide, nothing reruns.
    await writeFile(join(first.workspace, "result.txt"), "done by codex_cli");
    const dead = await setup({ directory: first.directory, alive: false, locks: restoreLocks(alive.locks) });
    await dead.service.settle();
    const recovered = dead.service.get(running.task.id)!;
    expect(recovered.state).toBe("verified");
    expect(recovered.reason).toMatch(/проверки прошли/);
    expect(dead.adapters[1].runs + dead.adapters[2].runs).toBe(0);
    release();
  });
});

describe("agent identity tokens", () => {
  it("gives launched agents their own identity and rejects forged or expired tokens", () => {
    let now = 1_000;
    const registry = new AgentRegistry([], { secret: Buffer.alloc(32, 1), now: () => now });
    const token = registry.issueAgentToken({ id: "app:tove", kind: "app", label: "Tove" }, 60_000);
    expect(registry.identityFromToken(token)).toMatchObject({ id: "app:tove", kind: "app", policy: { id: "agent", canSetComputerMode: false } });
    expect(registry.identityFromToken(registry.issueTaskToken("t-1", 60_000))).toMatchObject({ id: "task:t-1", taskId: "t-1", policy: { id: "child" } });
    const [payload] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ a: "owner", k: "app", e: now + 60_000 })).toString("base64url");
    expect(registry.identityFromToken(`${forged}.${token.split(".")[1]}`)).toBeUndefined();
    expect(new AgentRegistry([], { secret: Buffer.alloc(32, 2) }).identityFromToken(token)).toBeUndefined();
    now += 61_000;
    expect(registry.identityFromToken(`${payload}.${token.split(".")[1]}`)).toBeUndefined();
  });
});

describe("executor command lines", () => {
  it("runs Codex in a workspace-write sandbox without MCP, web or bypass flags", () => {
    const args = codexAgentExecArgs({}, { workdir: "C:/w" });
    expect(args).toContain("workspace-write");
    expect(args.join(" ")).toContain("mcp_servers={}");
    expect(args.join(" ")).not.toMatch(/dangerously|bypass|danger-full-access/);
    expect(codexAgentExecArgs({}, { workdir: "C:/w", readOnly: true, shell: false }).join(" ")).toContain("features.shell_tool=false");
  });

  it("gives Claude only file tools and test commands by default", () => {
    const tools = claudeAllowedTools({ spec: { goal: "x", checks: [{ type: "command", command: "node", args: ["--test"] }] } } as never);
    expect(tools).toContain("Edit");
    expect(tools).toContain("Bash(node:*)");
    expect(tools).not.toContain("Bash");
  });
});

function restoreLocks(previous: LockManager): LockManager {
  const locks = new LockManager();
  locks.restore({ locks: previous.list() });
  return locks;
}

describe("owner reserve calibration", () => {
  it("lets light work run on a busy machine but keeps heavy work behind the full RAM reserve", async () => {
    const busyMachine = async (): Promise<Telemetry> => ({ ...telemetry(), memory: { totalMiB: 32 * GiB, usedMiB: 27.5 * GiB, freeMiB: 4.5 * GiB } });
    const dispatcher = new ResourceDispatcher({ telemetry: busyMachine, mode: async () => effectiveComputerMode(defaultComputerModeState()), ownerApps: async () => [] });
    expect((await dispatcher.acquire({ holder: "cli", agentId: "a", purpose: "codex", class: "light", origin: "agent", ramMiB: 512 })).granted).toBe(true);
    expect(await dispatcher.acquire({ holder: "llm", agentId: "a", purpose: "model", class: "heavy", origin: "agent", ramMiB: 2 * GiB, vramMiB: GiB })).toMatchObject({ granted: false, waitFor: "resources" });
  });
});
