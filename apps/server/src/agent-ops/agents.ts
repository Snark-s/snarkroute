import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { AgentIdentity, AgentKind, AgentPolicy } from "./types";

/**
 * Who is asking and what it may do. MCP clients are identified by their
 * initialize clientInfo; delegated executors by a short-lived token signed by
 * this server and bound to their task. Policies come from the owner's file,
 * never from claims inside a prompt.
 */

export type AgentRecord = { id: string; kind: AgentKind; label: string; firstSeenAt: string; lastSeenAt: string; via: string; policyId: string };
export type AgentPolicies = { policies: Record<string, AgentPolicy>; assignments: Record<string, string> };

export function defaultAgentPolicies(roots: string[]): AgentPolicies {
  const agent: AgentPolicy = {
    id: "agent",
    allowedExecutors: ["local_route", "codex_cli", "claude_code"],
    maxDelegationDepth: 3,
    chainBudget: { tasks: 8, wallMinutes: 180, subscriptionRuns: 6 },
    workspaceRoots: roots,
    maxPriority: 70,
    canSetComputerMode: false,
    canUseHeavyGpu: true,
    dailyTaskLimit: 30
  };
  return {
    policies: {
      owner: { ...agent, id: "owner", maxDelegationDepth: 4, chainBudget: { tasks: 20, wallMinutes: 600, subscriptionRuns: 12 }, maxPriority: 100, canSetComputerMode: true, dailyTaskLimit: 200 },
      agent,
      child: { ...agent, id: "child", maxPriority: 60, chainBudget: { tasks: 4, wallMinutes: 120, subscriptionRuns: 3 } }
    },
    assignments: {}
  };
}

export class AgentRegistry {
  private records = new Map<string, AgentRecord>();
  private policies: AgentPolicies;
  private secret: Buffer;

  constructor(roots: string[], private readonly options: { persist?: (records: AgentRecord[]) => Promise<void>; secret?: Buffer; now?: () => number } = {}) {
    this.policies = defaultAgentPolicies(roots);
    this.secret = options.secret ?? randomBytes(32);
  }

  restore(state: { records?: AgentRecord[]; policies?: Partial<AgentPolicies> }): void {
    for (const record of state.records ?? []) this.records.set(record.id, record);
    if (state.policies?.policies) this.policies.policies = { ...this.policies.policies, ...state.policies.policies };
    if (state.policies?.assignments) this.policies.assignments = { ...state.policies.assignments };
  }

  list(): AgentRecord[] { return [...this.records.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)); }
  policy(id: string): AgentPolicy { return this.policies.policies[id] ?? this.policies.policies.agent; }
  policyDocument(): AgentPolicies { return structuredClone(this.policies); }

  owner(via = "workshop"): AgentIdentity { return this.touch("owner", "owner", "Владелец (Мастерская)", via); }

  /** Every MCP client gets an identity on its first call; its policy is the owner's assignment or the default. */
  mcpClient(clientName: string | undefined, label?: string): AgentIdentity {
    const name = sanitize(clientName) || "unknown-client";
    return this.touch(`mcp:${name}`, "mcp", label?.trim() || name, "mcp");
  }

  app(appId: string, label: string): AgentIdentity { return this.touch(`app:${sanitize(appId)}`, "app", label, "launcher"); }
  persona(taskId: string): AgentIdentity { return this.touch(`persona:${sanitize(taskId)}`, "persona", `PersonaCore ${taskId}`, "persona"); }

  /** Executors running a delegated task act as `task:<id>` and inherit the child policy. */
  taskAgent(taskId: string, label: string): AgentIdentity {
    const identity = this.touch(`task:${taskId}`, "task", label, "delegation");
    return { ...identity, taskId };
  }

  issueTaskToken(taskId: string, ttlMs: number): string {
    const payload = Buffer.from(JSON.stringify({ t: taskId, e: this.time() + ttlMs })).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  verifyTaskToken(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return undefined;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { t?: string; e?: number };
      return typeof parsed.t === "string" && typeof parsed.e === "number" && parsed.e > this.time() ? parsed.t : undefined;
    } catch { return undefined; }
  }

  private touch(id: string, kind: AgentKind, label: string, via: string): AgentIdentity {
    const at = new Date(this.time()).toISOString();
    const policyId = this.policies.assignments[id] ?? (kind === "owner" ? "owner" : kind === "task" ? "child" : "agent");
    const previous = this.records.get(id);
    const record: AgentRecord = { id, kind, label, via, policyId, firstSeenAt: previous?.firstSeenAt ?? at, lastSeenAt: at };
    this.records.set(id, record);
    // Persist new agents at once; refresh lastSeen at most once a minute.
    if (!previous || Date.parse(at) - Date.parse(previous.lastSeenAt) > 60_000) void this.options.persist?.(this.list()).catch(() => undefined);
    return { id, kind, label, policy: this.policy(policyId) };
  }

  private sign(payload: string): string { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  private time(): number { return this.options.now?.() ?? Date.now(); }
}

export function workspaceAllowed(path: string, roots: string[]): boolean {
  const target = norm(path);
  return roots.some(root => { const base = norm(root); return target === base || target.startsWith(`${base}\\`) || target.startsWith(`${base}/`); });
}

function norm(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function sanitize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/**
 * The short, stable hint every agent receives. Current capabilities are never
 * copied here: agents read them from the catalog when they need them.
 */
export const AGENT_OPS_BRIEF = [
  "SnarkRoute agent operations: before refusing a task you could hand off, call agent_capabilities (short list; agent_capability_detail for one entry).",
  "Delegate through agent_delegate_submit with a goal, acceptance criteria, machine checks, workspace and an idempotencyKey; the router picks a suitable permitted executor (local model first when it fits, then Codex and Claude Code subscriptions; never paid APIs) and the dispatcher decides when it may run.",
  "Delegate at once when a specialist is needed instead of retrying an unsuitable executor. Never claim quota, availability or success that SnarkRoute has not reported: availability is registered/discovered/available/verified, and quota without provider data is unknown.",
  "If a connection drops, read agent_delegate_status (or resubmit with the same idempotencyKey) instead of submitting again.",
  "Heavy local GPU/RAM work needs a resource lease (agent_resource_acquire, released when done) and respects the owner's computer mode (computer_mode_status): «Компьютер нужен мне» means no new heavy work.",
  "Never stop other agents' processes or restart services they use; shared working copies are locked per task."
].join(" ");

export function agentBrief(identity: AgentIdentity, extra?: { taskId?: string; chainDepth?: number; budget?: string; apiUrl?: string }): string {
  const lines = [
    `Your SnarkRoute agent id: ${identity.id} (policy ${identity.policy.id}; delegation depth limit ${identity.policy.maxDelegationDepth}).`,
    AGENT_OPS_BRIEF
  ];
  if (extra?.taskId) {
    lines.push(`You are executing delegated task ${extra.taskId} at depth ${extra.chainDepth ?? 1}.${extra.budget ? ` Remaining chain budget: ${extra.budget}.` : ""}`);
    if (extra.apiUrl) lines.push(`To delegate a sub-task or read the catalog without MCP, call ${extra.apiUrl}/api/agent-ops (catalog, tasks) with header "x-snarkroute-agent-token: $SNARKROUTE_AGENT_TOKEN"; sub-tasks share this task's budget, and delegating the same goal back up the chain is refused.`);
  }
  return lines.join("\n");
}
