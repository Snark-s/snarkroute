import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startAgentOps, type AgentOps } from "../agent-ops";
import { AGENT_OPS_BRIEF, agentBrief } from "../agent-ops/agents";
import { rankExecutors } from "../agent-ops/router";
import { AgentOpsError, normalizeSpec } from "../agent-ops/tasks";
import type { AgentIdentity, TaskSpec, TaskState } from "../agent-ops/types";
import { errorMessage } from "../services/errors";

export const AGENT_OPS_INSTRUCTIONS = ` ${AGENT_OPS_BRIEF} Call agent_whoami once to learn your agent id and permissions.`;

const check = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), command: z.string().min(1).max(200), args: z.array(z.string().max(2000)).max(40).optional(), timeoutMs: z.number().int().min(1000).max(900_000).optional() }),
  z.object({ type: z.literal("file_exists"), path: z.string().min(1).max(1000) }),
  z.object({ type: z.literal("file_contains"), path: z.string().min(1).max(1000), text: z.string().min(1).max(2000) })
]);

const taskSpecShape = {
  goal: z.string().min(1).max(40_000).describe("What must be achieved, self-contained: the executor sees nothing else."),
  title: z.string().max(120).optional(),
  acceptance: z.array(z.string().max(2000)).max(30).optional().describe("Human-readable criteria of done."),
  checks: z.array(check).max(12).optional().describe("Machine checks SnarkRoute runs itself in the working folder after the executor finishes (e.g. a test command). Without checks the task ends in awaiting_verification."),
  inputs: z.array(z.string().max(4000)).max(50).optional(),
  workspace: z.string().max(1000).optional().describe("Absolute working folder; must be inside the roots your policy allows. One task at a time per folder unless isolation=worktree."),
  isolation: z.enum(["shared", "worktree"]).optional().describe("worktree: a separate git worktree and branch for independent work."),
  constraints: z.array(z.string().max(2000)).max(30).optional(),
  permissions: z.object({ fileWrite: z.boolean().optional(), shell: z.enum(["none", "tests", "workspace"]).optional(), network: z.boolean().optional() }).optional(),
  budget: z.object({ wallMinutes: z.number().int().min(1).max(600).optional().describe("Active execution minutes (executor, acceptance, reworks); waiting for a window or resources is not counted."),
    subscriptionRuns: z.number().int().min(0).max(20).optional(), maxTurns: z.number().int().min(1).max(200).optional(), maxReworks: z.number().int().min(0).max(5).optional() }).optional(),
  deadline: z.string().max(40).optional().describe("Optional wall-clock deadline (ISO); it keeps running while the task waits."),
  priority: z.number().int().min(0).max(100).optional(),
  executor: z.string().max(64).optional().describe("auto (default), local_route, codex_cli, claude_code or another registered executor."),
  allowedExecutors: z.array(z.string().max(64)).max(10).optional(),
  requirements: z.object({ kind: z.enum(["code_edit", "code_review", "text", "analysis"]).optional(), quality: z.enum(["basic", "normal", "high"]).optional(), contextTokens: z.number().int().min(1).max(2_000_000).optional() }).optional(),
  idempotencyKey: z.string().max(200).optional().describe("Resubmitting with the same key returns the existing task instead of running it twice."),
  parentTaskId: z.string().max(80).optional(),
  onPartial: z.enum(["block", "continue"]).optional(),
  allowDuplicate: z.boolean().optional()
};

export function registerAgentOpsTools(server: McpServer, identityOf: (ops: AgentOps) => AgentIdentity): void {
  const run = (fn: (ops: AgentOps, identity: AgentIdentity) => Promise<unknown>) => async () => {
    // MCP clients are agents; the owner's rights come only from the Workshop session.
    try {
      const ops = await startAgentOps();
      return text(await fn(ops, identityOf(ops)));
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(error instanceof AgentOpsError ? { code: error.code, error: error.message, details: error.details } : { error: errorMessage(error) }) }] };
    }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("agent_whoami", {
    description: "Your SnarkRoute agent identity, permissions (allowed executors, delegation depth, chain budget, workspace roots) and the short operating brief. Call once per session.",
    inputSchema: {}, annotations: readOnly
  }, async () => run(async (ops, identity) => ({ identity: { id: identity.id, kind: identity.kind, policy: identity.policy }, brief: agentBrief(identity), mode: await ops.mode() }))());

  server.registerTool("agent_capabilities", {
    description: "Short catalog of executors, model groups, tool groups, local services and specialised agents, each with registered/discovered/available/verified status, source and check time, cost tier and how to invoke. Use agent_capability_detail for one entry.",
    inputSchema: { kind: z.enum(["executor", "model_group", "tool_group", "service", "agent"]).optional(), query: z.string().max(200).optional(), availableOnly: z.boolean().optional() },
    annotations: readOnly
  }, async input => run(async (ops, identity) => ({ entries: (await ops.catalog.list(identity, input)).map(entry => ({ id: entry.id, kind: entry.kind, title: entry.title, summary: entry.summary,
    registered: entry.status.registered, discovered: entry.status.discovered, available: entry.status.available, verified: entry.status.verified?.at ?? null,
    checkedAt: entry.status.checkedAt, source: entry.status.source, detail: entry.status.detail, permitted: entry.permitted, cost: entry.cost, resources: entry.resources, invoke: entry.invoke })) }))());

  server.registerTool("agent_capability_detail", {
    description: "Full details of one catalog entry: executor profile, login and quota ledger with sources, limits; models of a group; tools of a group; measured resource profiles of a service.",
    inputSchema: { id: z.string().min(1).max(200) }, annotations: readOnly
  }, async input => run(async (ops, identity) => (await ops.catalog.detail(identity, input.id)) ?? { error: "Нет такой записи каталога." })());

  server.registerTool("agent_route_preview", {
    description: "Dry run of executor routing for a task contract: which executors fit, in what order and why, and whether each could start now. Submits nothing.",
    inputSchema: taskSpecShape, annotations: readOnly
  }, async input => run(async (ops, identity) => {
    const spec = normalizeSpec(input as TaskSpec);
    await ops.tasks.refreshExecutorProbes(false);
    return { candidates: rankExecutors({ spec, policy: identity.policy, adapters: ops.adapters, probes: ops.tasks.probeSnapshot() })
      .map(candidate => ({ ...candidate, availability: ops.ledger.availability(candidate.executorId, candidate.tier) })) };
  })());

  server.registerTool("agent_delegate_submit", {
    description: "Submit a durable task to the best suitable permitted executor (local route, Codex CLI, Claude Code; never paid APIs). Returns a task id at once; it never reports completion on submission. Waiting for resources, the work window or an executor is shown with a reason. Use an idempotencyKey; after a dropped connection call agent_delegate_status instead of resubmitting.",
    inputSchema: taskSpecShape, annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true }
  }, async input => run(async (ops, identity) => {
    const { task, deduplicated } = await ops.tasks.submit(identity, input as TaskSpec);
    return { taskId: task.id, deduplicated, state: task.state, reason: task.reason, next: "agent_delegate_status / agent_delegate_result" };
  })());

  server.registerTool("agent_delegate_status", {
    description: "Persisted state of a delegated task: queued, waiting_window, waiting_resources, waiting_executor, running, blocked, failed, cancelled, unknown_outcome, awaiting_acceptance (executor finished, acceptance running or waiting) or verified (accepted); the reason, executor, attempts with reworks, acceptance decisions, chain budget and recent events. Only your own tasks and your chain are readable.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: readOnly
  }, async input => run(async (ops, identity) => {
    const task = ops.tasks.requireReadable(input.taskId, identity);
    return { id: task.id, title: task.title, state: task.state, reason: task.reason, executor: task.executor ?? null, priority: task.priority, chain: task.chain,
      attempts: task.attempts.map(attempt => ({ n: attempt.n, executor: attempt.executor, outcome: attempt.outcome ?? "running", failureClass: attempt.failureClass, changedFiles: attempt.changedFiles?.length ?? 0, rework: attempt.rework?.n, startedAt: attempt.startedAt, endedAt: attempt.endedAt })),
      acceptance: task.acceptance ? { reworks: task.acceptance.reworks, maxReworks: task.acceptance.maxReworks, ownerAction: task.acceptance.ownerAction, decisions: task.acceptance.decisions.slice(-6) } : null,
      chainBudget: ops.tasks.chainBudget(task.chain.rootTaskId), events: (await ops.tasks.events(task.id)).slice(-12) };
  })());

  server.registerTool("agent_delegate_result", {
    description: "Result of a delegated task: executor summary, changed files, outcomes of SnarkRoute's own checks, acceptance decisions (accepted by checks, by the reviewer or by the owner; reworks with unmet criteria), branch (worktree), actual executor and model, cost tier. accepted=true only after acceptance.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: readOnly
  }, async input => run(async (ops, identity) => {
    const task = ops.tasks.requireReadable(input.taskId, identity);
    return { id: task.id, state: task.state, reason: task.reason, accepted: task.state === "verified", verified: task.state === "verified", result: task.result ?? null, acceptance: task.acceptance ?? null };
  })());

  server.registerTool("agent_delegate_cancel", {
    description: "Cancel your own task (or a sub-task in your chain). Stops only the executor process SnarkRoute started for it; never other processes.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async input => run(async (ops, identity) => { const task = await ops.tasks.cancel(input.taskId, identity); return { id: task.id, state: task.state, reason: task.reason }; })());

  server.registerTool("agent_delegate_list", {
    description: "Your delegated tasks (or all, for the owner) with state and reason.",
    inputSchema: { states: z.array(z.string()).max(11).optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: readOnly
  }, async input => run(async (ops, identity) => ({ tasks: ops.tasks.list({ agentId: identity.kind === "owner" ? undefined : identity.id, states: input.states as TaskState[] | undefined, limit: input.limit ?? 30 })
    .map(task => ({ id: task.id, title: task.title, state: task.state, reason: task.reason, executor: task.executor ?? null, updatedAt: task.updatedAt })) }))());

  server.registerTool("agent_delegate_resolve", {
    description: "Decide a blocked or unknown_outcome task after looking at its files: continue (another executor resumes from the current state), requeue, or mark_failed. mark_verified is owner-only.",
    inputSchema: { taskId: z.string().min(1).max(80), action: z.enum(["continue", "requeue", "mark_failed", "mark_verified"]), note: z.string().max(1000).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async (ops, identity) => { const task = await ops.tasks.resolve(input.taskId, identity, input.action, input.note); return { id: task.id, state: task.state, reason: task.reason }; })());

  server.registerTool("agent_delegate_verify", {
    description: "Re-run acceptance (machine checks, then the reviewer) on the task's current files, for example after a manual fix.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async (ops, identity) => { const task = await ops.tasks.verify(input.taskId, identity); return { id: task.id, state: task.state, reason: task.reason, checks: task.result?.checks ?? [] }; })());

  server.registerTool("agent_resource_acquire", {
    description: "Atomically reserve GPU/VRAM, RAM, CPU or heavy disk for your own heavy work outside delegation (a script, a render, a model load). Respects the computer mode and the owner's reserve; returns a lease id or why to wait. Release it with agent_resource_release as soon as you finish; heartbeat long work.",
    inputSchema: { class: z.enum(["heavy", "light"]), purpose: z.string().min(1).max(200), vramMiB: z.number().int().min(0).max(200_000).optional(), ramMiB: z.number().int().min(0).max(1_000_000).optional(),
      cpuSlots: z.number().int().min(1).max(64).optional(), diskHeavy: z.boolean().optional(), runtimeId: z.string().max(80).optional(), ttlMinutes: z.number().int().min(1).max(120).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async (ops, identity) => {
    const decision = await ops.acquireAgentLease(identity, { class: input.class, purpose: input.purpose, vramMiB: input.vramMiB, ramMiB: input.ramMiB, cpuSlots: input.cpuSlots, diskHeavy: input.diskHeavy, runtimeId: input.runtimeId, ttlMs: input.ttlMinutes ? input.ttlMinutes * 60_000 : undefined });
    return decision.granted ? { granted: true, leaseId: decision.lease.id, vramMiB: decision.lease.vramMiB, estimateSource: decision.lease.estimateSource, ttlMs: decision.lease.ttlMs } : decision;
  })());

  server.registerTool("agent_resource_heartbeat", {
    description: "Keep your resource lease alive during long work.", inputSchema: { leaseId: z.string().min(1).max(80) }, annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async ops => ({ ok: ops.dispatcher.heartbeat(input.leaseId) }))());

  server.registerTool("agent_resource_release", {
    description: "Release your resource lease.", inputSchema: { leaseId: z.string().min(1).max(80) }, annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async (ops, identity) => ({ released: ops.releaseAgentLease(identity, input.leaseId) }))());

  server.registerTool("computer_mode_status", {
    description: "The owner's computer mode (Компьютер нужен мне / Можно работать в фоне / Компьютер свободен), its source (manual, schedule in Europe/Moscow, conservative default), limits and reserves, owner applications running, resource load, active leases, locks and queue counts. Agents cannot change the mode.",
    inputSchema: {}, annotations: readOnly
  }, async () => run(async ops => {
    const status = await ops.status();
    return { mode: status.mode, manual: status.manual, schedule: status.schedule, ownerApps: status.ownerApps, resources: status.resources, leases: status.leases.map(lease => ({ id: lease.id, purpose: lease.purpose, class: lease.class, vramMiB: lease.vramMiB, agentId: lease.agentId, state: lease.state })),
      locks: status.locks.map(lock => ({ key: lock.key, task: lock.ownerTaskId, state: lock.state })), queue: status.queue };
  })());

  // Kept for clients that learned the Phase 1 name; now backed by the live catalog.
  server.registerTool("coding_agents_discover", {
    description: "Local coding executors (Codex CLI, Claude Code, local route) with install/login status, quota ledger (unknown unless a provider reported it) and availability. Same data as agent_capabilities kind=executor; delegate with agent_delegate_submit.",
    inputSchema: {}, annotations: readOnly
  }, async () => run(async (ops, identity) => {
    await ops.tasks.refreshExecutorProbes(false);
    return { schema_version: 2, executors: (await ops.catalog.list(identity, { kind: "executor" })).map(entry => ({ id: entry.id.slice("executor:".length), title: entry.title, discovered: entry.status.discovered,
      available: entry.status.available, verified: entry.status.verified, checkedAt: entry.status.checkedAt, detail: entry.status.detail, summary: entry.summary })), delegation: { status: "implemented", submit: "agent_delegate_submit" } };
  })());
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
