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
  z.object({ type: z.literal("file_contains"), path: z.string().min(1).max(1000), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("file_content"), path: z.string().min(1).max(1000) }),
  z.object({ type: z.literal("http"), url: z.string().url().max(2000), status: z.number().int().min(100).max(599).optional(), text: z.string().max(2000).optional(), json: z.object({ path: z.string().min(1), equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).optional(), timeoutMs: z.number().int().min(1000).max(60000).optional() }),
  z.object({ type: z.literal("process"), pid: z.number().int().positive(), image: z.string().max(200).optional() }),
  z.object({ type: z.literal("tool"), tool: z.string().min(1).max(80), arguments: z.record(z.unknown()).optional(), json: z.object({ path: z.string().min(1).max(200), equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).optional(), text: z.string().min(1).max(2000).optional() }),
  z.object({ type: z.literal("tool_used"), tool: z.string().min(1).max(80), effectKey: z.string().max(80).optional() }),
  z.object({ type: z.literal("tool_observations") }),
  z.object({ type: z.literal("acceptor_cycle") }),
  z.object({ type: z.literal("tool_scope"), allowed: z.array(z.string().min(1).max(80)).max(30) })
]);
const criterion = z.object({ id: z.string().min(1).max(80), description: z.string().min(1).max(2000), required: z.boolean().optional(), checkIndexes: z.array(z.number().int().min(0).max(29)).max(30).optional(), review: z.enum(["machine", "model", "unverifiable"]), unverifiableReason: z.string().max(2000).optional(), maxAgeMs: z.number().int().min(1000).max(86400000).optional() });

const taskSpecShape = {
  goal: z.string().min(1).max(40_000).describe("What must be achieved, self-contained: the executor sees nothing else."),
  title: z.string().max(120).optional(),
  actor: z.string().max(80).optional(), tools: z.array(z.string().max(80)).max(30).optional(),
  expectedResult: z.string().max(4000).optional(),
  criteria: z.array(criterion).min(1).max(30).optional().describe("Immutable requirements with explicit check indexes (zero based). machine only for objective criteria; model for content quality; unverifiable with a reason when evidence cannot be obtained."),
  effects: z.array(z.object({ key: z.string().min(1).max(80), description: z.string().min(1).max(2000), check })).max(30).optional().describe("Allowed external actions with independent reconciliation checks. Reserve BEFORE acting with agent_task_effect; never repeat an uncertain outcome."),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(100).optional(), sameFailureLimit: z.number().int().min(1).max(20).optional(), delayMs: z.number().int().min(10).max(3600000).optional(), maxDelayMs: z.number().int().min(10).max(3600000).optional() }).optional(),
  review: z.object({ forceStrong: z.boolean().optional(), timeoutMs: z.number().int().min(1000).max(900000).optional(), maxRuns: z.number().int().min(1).max(100).optional(), allowUnknownSubscriptionQuota: z.boolean().optional() }).optional(),
  resourceLimits: z.object({ vramMiB: z.number().int().min(0).optional(), ramMiB: z.number().int().min(0).optional(), cpuSlots: z.number().int().min(1).optional() }).optional(),
  acceptance: z.array(z.string().max(2000)).max(30).optional().describe("Human-readable criteria of done."),
  checks: z.array(check).max(30).optional().describe("Independent observations from the submitted contract. Test success does not prove an external outcome; map each criterion to its own checks."),
  inputs: z.array(z.string().max(4000)).max(50).optional(),
  workspace: z.string().max(1000).optional().describe("Absolute working folder; must be inside the roots your policy allows. One task at a time per folder unless isolation=worktree."),
  isolation: z.enum(["shared", "worktree"]).optional().describe("worktree: a separate git worktree and branch for independent work."),
  constraints: z.array(z.string().max(2000)).max(30).optional(),
  permissions: z.object({ fileWrite: z.boolean().optional(), shell: z.enum(["none", "tests", "workspace"]).optional(), network: z.boolean().optional() }).optional(),
  budget: z.object({ wallMinutes: z.number().int().min(1).max(600).optional(), activeMinutes: z.number().int().min(1).max(600).optional(), subscriptionRuns: z.number().int().min(0).max(20).optional(), maxTurns: z.number().int().min(1).max(200).optional(), providerCost: z.literal(0).optional() }).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  executor: z.string().max(64).optional().describe("auto (default), local_route, codex_cli, claude_code or another registered executor."),
  allowedExecutors: z.array(z.string().max(64)).max(10).optional(),
  requirements: z.object({ kind: z.enum(["code_edit", "code_review", "text", "analysis", "agent_tool"]).optional(), quality: z.enum(["basic", "normal", "high"]).optional(), contextTokens: z.number().int().min(1).max(2_000_000).optional() }).optional(),
  idempotencyKey: z.string().max(200).optional().describe("Resubmitting with the same key returns the existing task instead of running it twice."),
  parentTaskId: z.string().max(80).optional(),
  onPartial: z.enum(["block", "continue"]).optional(),
  allowDuplicate: z.boolean().optional()
};

export function registerAgentOpsTools(server: McpServer, identityOf: (ops: AgentOps) => AgentIdentity): void {
  const run = (fn: (ops: AgentOps, identity: AgentIdentity) => Promise<unknown>) => async () => {
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
    description: "Persisted state of a delegated task: queued, waiting_window, waiting_resources, waiting_executor, running, blocked, failed, cancelled, unknown_outcome, awaiting_verification or verified; the reason, executor, attempts, chain budget and recent events.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: readOnly
  }, async input => run(async ops => {
    const task = ops.tasks.get(input.taskId);
    if (!task) throw new AgentOpsError("TASK_NOT_FOUND", `Задача ${input.taskId} не найдена.`);
    return { id: task.id, title: task.title, state: task.state, reason: task.reason, executor: task.executor ?? null, priority: task.priority, chain: task.chain,
      attempts: task.attempts.map(attempt => ({ n: attempt.n, executor: attempt.executor, outcome: attempt.outcome ?? "running", failureClass: attempt.failureClass, changedFiles: attempt.changedFiles?.length ?? 0, startedAt: attempt.startedAt, endedAt: attempt.endedAt })),
      chainBudget: ops.tasks.chainBudget(task.chain.rootTaskId), lastDecision: task.reviews?.at(-1), nextStep: task.nextStep, nextAttemptAt: task.nextAttemptAt, events: (await ops.tasks.events(task.id)).slice(-12) };
  })());

  server.registerTool("agent_delegate_result", {
    description: "Result of a delegated task: executor summary, changed files, outcomes of SnarkRoute's own checks, branch (worktree), actual executor and model, cost tier. verified=true only after checks passed or the owner confirmed.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: readOnly
  }, async input => run(async ops => {
    const task = ops.tasks.get(input.taskId);
    if (!task) throw new AgentOpsError("TASK_NOT_FOUND", `Задача ${input.taskId} не найдена.`);
    return { id: task.id, state: task.state, reason: task.reason, verified: task.state === "verified", result: task.result ?? null, contract: task.contract, decisions: task.reviews, evidence: task.evidence };
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
    description: "Run the independent Acceptor: criterion evidence, code checks and model review when needed. A rejection enqueues continuation, while missing reviewer resources preserve awaiting_verification.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async (ops, identity) => { const task = await ops.tasks.verify(input.taskId, identity); return { id: task.id, state: task.state, reason: task.reason, checks: task.result?.checks ?? [] }; })());

  server.registerTool("agent_acceptor_status", {
    description: "Read the durable acceptance contract, every criterion, independent evidence with timestamps and attempt ids, structured decisions, next step, effects journal, reviewer runs and budgets. Executor session completion never means task acceptance.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: readOnly
  }, async input => run(async ops => { const task = ops.tasks.get(input.taskId); if (!task) throw new AgentOpsError("TASK_NOT_FOUND", "Задача не найдена."); return { id: task.id, state: task.state, reason: task.reason, contract: task.contract, evidence: task.evidence, decisions: task.reviews, reviewerRuns: task.reviewRuns, effects: task.effects, nextStep: task.nextStep, nextAttemptAt: task.nextAttemptAt, attempts: task.attempts.length, budget: ops.tasks.chainBudget(task.chain.rootTaskId) }; })());

  server.registerTool("agent_acceptor_inspect", {
    description: "Submit an existing result for independent acceptance without first running an executor. The contract, permissions, evidence and budgets are persisted; a failed result may enqueue authorized continuation. Claims in inputs are never proof. Use for results produced outside the delegation queue.",
    inputSchema: taskSpecShape, annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true }
  }, async input => run(async (ops, identity) => { const { task, deduplicated } = await ops.tasks.submit(identity, input as TaskSpec, { inspectExisting: true }); return { taskId: task.id, deduplicated, state: task.state, reason: task.reason }; })());

  for (const action of ["pause", "resume"] as const) server.registerTool(`agent_delegate_${action}`, {
    description: action === "pause" ? "Pause your task at the next stage boundary. Persists across restarts and prevents further executor/reviewer stages." : "Resume a paused task from saved state; this does not authorize repeating uncertain external actions.",
    inputSchema: { taskId: z.string().min(1).max(80) }, annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async (ops, identity) => { const task = await ops.tasks[action](input.taskId, identity); return { id: task.id, state: task.state, reason: task.reason }; })());

  server.registerTool("agent_task_effect", {
    description: "Reserve a declared external action BEFORE acting (begin). Execute only if execute=true; duplicate/uncertain receipts return false. reconcile independently reads the contract's check. not_performed requires owner evidence and note before authorizing any retry.",
    inputSchema: { taskId: z.string().min(1).max(80), key: z.string().min(1).max(80), action: z.enum(["begin", "reconcile", "not_performed"]), note: z.string().max(2000).optional() }, annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true }
  }, async input => run(async (ops, identity) => ops.tasks.effect(input.taskId, identity, input.key, input.action, input.note))());

  server.registerTool("agent_task_amend", {
    description: "The submitting principal may clarify requirements between stages with an audit note. The executor and reviewer cannot weaken their contract, and scope/permissions cannot expand.",
    inputSchema: { taskId: z.string().min(1).max(80), note: z.string().min(1).max(2000), goal: z.string().min(1).max(40000).optional(), expectedResult: z.string().max(4000).optional(), criteria: z.array(criterion).min(1).max(30).optional(), checks: z.array(check).max(30).optional() }, annotations: { readOnlyHint: false, openWorldHint: false }
  }, async input => run(async (ops, identity) => { const { taskId, note, ...patch } = input; const task = await ops.tasks.amend(taskId, identity, patch, note); return { id: task.id, contract: task.contract }; })());

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
