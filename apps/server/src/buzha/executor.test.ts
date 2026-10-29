import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuzhaExecutor } from "./executor";
import { BuzhaTools, BUZHA_TOOLS } from "./tools";
import { AgentRegistry } from "../agent-ops/agents";
import { AgentOpsStore } from "../agent-ops/store";
import { AgentTaskService } from "../agent-ops/tasks";
import { LockManager } from "../agent-ops/locks";
import { QuotaLedger } from "../agent-ops/quota-ledger";
import { ResourceDispatcher } from "../agent-ops/resources";
import { defaultComputerModeState, effectiveComputerMode } from "../agent-ops/computer-mode";
import type { AgentTask, TaskSpec } from "../agent-ops/types";

const dirs: string[] = [], services: AgentTaskService[] = [];
afterEach(async () => { for (const s of services.splice(0)) { s.close(); await s.drain(); } for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "buzha-agent-")); dirs.push(dir); const workspace = join(dir, "work"); await mkdir(workspace);
  let bridgeCalls = 0, modelCalls = 0, processedObservation = false;
  const tools = new BuzhaTools({ bridge: async name => { bridgeCalls++; return name === "bridge_status" ? { status: "ok" } : { available: true, sessions: [{ id: "default", profile_directory: "Profile 13", available: true }] }; } });
  const model = { provider: "chatgpt_subscription", providerModelId: "controlled-model", displayName: "Controlled model", runtimeId: "subscription", contextTokens: 100000 };
  const adapter = new BuzhaExecutor("codex", { tools, model: async () => model, memory: async () => ({ identity: "Бужа, постоянная помощница", model: "auto", messages: [], jobs: [], tasks: [] }),
    runText: async (_model, prompt) => {
      modelCalls++;
      if (modelCalls % 2) return { ok: true, actualModel: "real-model-id", text: JSON.stringify({ actions: [{ tool: "bridge_status", arguments: {} }, { tool: "browser_sessions", arguments: {} }], done: false, summary: "Читаю реальные инструменты" }) };
      processedObservation ||= prompt.includes('\\"status\\":\\"ok\\"');
      expect(prompt).toContain('"plans":[{"actions":');
      expect(prompt).toContain("Текущий шаг инструментального цикла: 2");
      const complete = prompt.includes("Это ПРОДОЛЖЕНИЕ");
      return { ok: true, actualModel: "real-model-id", text: JSON.stringify({ actions: [{ tool: "workspace_write", arguments: { path: "answer.md", content: complete ? "SnarkBridge: ok\nProfile 13\nПроверено" : "SnarkBridge: ok" } }], done: true, summary: complete ? "Исправила недочёт по фактическим ответам инструментов" : "готово" }) };
    } });
  const store = new AgentOpsStore(join(dir, "store")), registry = new AgentRegistry([dir], { secret: Buffer.alloc(32, 5) }), ledger = new QuotaLedger(), mode = async () => effectiveComputerMode(defaultComputerModeState());
  const dispatcher = new ResourceDispatcher({ mode, ownerActivity: async () => ({ busy: false, confidence: "measured" as const, reasons: [], signals: [] }), telemetry: async () => ({ memory: { totalMiB: 64000, freeMiB: 50000, usedMiB: 14000 }, cpuCount: 16, capturedAt: new Date().toISOString() }) });
  const service = new AgentTaskService({ store, registry, ledger, dispatcher, locks: new LockManager(), adapters: [adapter], mode, apiUrl: "http://127.0.0.1:1", worktreeRoot: join(dir, "worktrees"), tickMs: 60000, toolCheck: (task, check) => tools.check(task, check) }); await service.init(); services.push(service);
  const spec: TaskSpec = { actor: "buzha", goal: "Проверь инструменты и полный локальный ответ", tools: BUZHA_TOOLS, workspace, permissions: { fileWrite: true, shell: "tests", network: false }, requirements: { kind: "agent_tool", quality: "high" },
    checks: [{ type: "tool", tool: "bridge_status", json: { path: "status", equals: "ok" } }, { type: "tool_used", tool: "browser_sessions" }, { type: "file_contains", path: "answer.md", text: "Проверено" }],
    criteria: [{ id: "bridge", description: "Независимый ответ инструмента", review: "machine", checkIndexes: [0] }, { id: "tool_cycle", description: "Модель вызвала рабочую сессию", review: "machine", checkIndexes: [1] }, { id: "complete", description: "Полный ответ", review: "machine", checkIndexes: [2] }], retry: { delayMs: 10, maxDelayMs: 100, maxAttempts: 3 }, budget: { subscriptionRuns: 6, wallMinutes: 3, maxTurns: 4 }, allowedExecutors: [adapter.id] };
  return { service, registry, spec, tools, workspace, modelCalls: () => modelCalls, bridgeCalls: () => bridgeCalls, processed: () => processedObservation };
}
async function until(service: AgentTaskService, id: string) { for (let n = 0; n < 500; n++) { service.kick(); await service.settle(); const task = service.get(id)!; if (["verified", "blocked", "failed"].includes(task.state)) return task; await new Promise(r => setTimeout(r, 10)); } throw new Error(service.get(id)?.reason); }
describe("persistent Buzha executor and shared Acceptor", () => {
  it("performs tools, consumes observations, automatically repairs and is independently accepted", async () => {
    const f = await fixture(); const { task } = await f.service.submit(f.registry.app("buzha", "Бужа"), f.spec);
    const final = await until(f.service, task.id); expect(final.state).toBe("verified"); expect(final.attempts).toHaveLength(2); expect(final.reviews?.map(r => r.decision)).toEqual(["continue", "accept"]);
    expect(f.processed()).toBe(true); expect(f.modelCalls()).toBe(4); expect(f.bridgeCalls()).toBeGreaterThanOrEqual(6); expect(final.attempts.every(a => a.provider === "chatgpt_subscription" && a.model === "real-model-id")).toBe(true);
    expect(f.service.budgetUsage(final).subscriptionRunsUsed).toBe(4); expect(await readFile(join(f.workspace, "answer.md"), "utf8")).toContain("Проверено");
  });
  it("preserves scope and refuses another profile or a write outside the workspace", async () => {
    const f = await fixture(); const task = { id: "test", agentId: "app:buzha", workdir: f.workspace, spec: f.spec } as AgentTask;
    await expect(f.tools.invoke(task, "workspace_write", { path: "../identity.md", content: "changed" })).rejects.toThrow();
    const wrong = new BuzhaTools({ bridge: async () => ({ sessions: [{ id: "default", available: true, profile_directory: "Default" }] }) });
    await expect(wrong.invoke(task, "browser_tabs", { session_id: "other" })).rejects.toThrow(/Profile 13/);
    await expect(f.tools.invoke({ ...task, agentId: "app:other" }, "bridge_status", {})).rejects.toThrow();
    expect((await f.tools.check(task, { type: "tool", tool: "workspace_write", arguments: { path: "x", content: "x" }, json: { path: "written", equals: true } })).ok).toBe(false);
  });
  it("does not accept a narrative response as tool capability", async () => {
    const f = await fixture(); const actor = new BuzhaExecutor("codex", { model: async () => ({ provider: "chatgpt_subscription", providerModelId: "x", displayName: "x", runtimeId: "subscription", contextTokens: 100000 }), tools: f.tools, memory: async () => ({}), runText: async () => ({ ok: true, text: "Готово, я всё сделала" }) });
    const result = await actor.run({ task: { agentId: "app:buzha", spec: f.spec, attempts: [{ n: 1 }] } as AgentTask, prompt: "test", brief: "", workdir: f.workspace, env: {}, signal: new AbortController().signal, timeoutMs: 10000, maxTurns: 2, remainingSubscriptionRuns: 2, log: () => {}, onPid: () => {} });
    expect(result.ok).toBe(false); expect(result.message).toContain("не подтверждена"); expect(f.bridgeCalls()).toBe(0);
  });
});
