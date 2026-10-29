/**
 * Shared vocabulary of the agent operations layer: computer modes, resource
 * leases, executor quota, delegated tasks. Persisted under data/agent-ops.
 */

export type ComputerMode = "owner_busy" | "background" | "free";

export const COMPUTER_MODE_LABELS: Record<ComputerMode, string> = {
  owner_busy: "Компьютер нужен мне",
  background: "Можно работать в фоне",
  free: "Компьютер свободен"
};

export type TaskState =
  | "queued"
  | "waiting_window"
  | "waiting_resources"
  | "waiting_executor"
  | "running"
  | "paused"
  | "blocked"
  | "failed"
  | "cancelled"
  | "unknown_outcome"
  | "awaiting_verification"
  | "verified";

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  queued: "в очереди",
  waiting_window: "ждёт рабочего окна",
  waiting_resources: "ждёт ресурсов",
  waiting_executor: "ждёт исполнителя",
  running: "выполняется",
  paused: "приостановлена",
  blocked: "заблокирована",
  failed: "ошибка",
  cancelled: "отменена",
  unknown_outcome: "неизвестный исход",
  awaiting_verification: "ждёт проверки",
  verified: "проверена"
};

export const TERMINAL_STATES = new Set<TaskState>(["failed", "cancelled", "verified"]);
export const WAITING_STATES = new Set<TaskState>(["queued", "waiting_window", "waiting_resources", "waiting_executor"]);

/** Why an executor attempt ended; quota, rate limit, auth, network and process failures are kept apart. */
export type FailureClass =
  | "quota_exhausted"
  | "rate_limited"
  | "auth"
  | "network"
  | "process"
  | "timeout"
  | "model_unavailable"
  | "cancelled"
  | "verification"
  | "budget";

export type TaskCheck =
  | { type: "command"; command: string; args?: string[]; timeoutMs?: number }
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_content"; path: string }
  | { type: "http"; url: string; status?: number; text?: string; json?: { path: string; equals: string | number | boolean | null }; timeoutMs?: number }
  | { type: "process"; pid: number; image?: string }
  | { type: "tool"; tool: string; arguments?: Record<string, unknown>; json: { path: string; equals: string | number | boolean | null } }
  | { type: "tool_used"; tool: string }
  | { type: "tool_observations" }
  | { type: "acceptor_cycle" }
  | { type: "tool_scope"; allowed: string[] };
// Re-observe the read tools used by an actor, rather than trusting its saved report.
export type AgentToolCall = { id: string; attempt: number; at: string; tool: string; arguments: Record<string, unknown>; ok: boolean; result: unknown; provider?: string; model?: string };
export type ModelCall = { id?: string; at: string; provider: string; model: string; tier: "local" | "subscription"; ok: boolean; runId?: string; sessionId?: string };

export type TaskCriterion = { id: string; description: string; required?: boolean; checkIndexes?: number[]; review: "machine" | "model" | "unverifiable"; unverifiableReason?: string; maxAgeMs?: number };
export type TaskContract = { version: 1; revision: number; originalGoal: string; expectedResult: string; criteria: TaskCriterion[]; amendments: Array<{ at: string; by: string; note: string; previous: TaskSpec }> };
export type CriterionVerdict = { criterionId: string; status: "confirmed" | "missing" | "unverifiable"; evidenceIds: string[]; reason: string };
export type TaskEvidence = { id: string; attempt: number; revision: number; criterionId: string; checkIndex: number; source: string; observedAt: string; independent: true; ok: boolean; detail: string; content?: string; truncated?: boolean; digest: string };
export type AcceptorDecision = "accept" | "continue" | "change_approach" | "wait_resource" | "blocked" | "owner_action";
export type AcceptanceReview = { id: string; at: string; attempt: number; revision: number; decision: AcceptorDecision; reason: string; nextStep: string; criteria: CriterionVerdict[]; failureSignature: string; resultFingerprint: string; strategy: string; reviewer?: { executor: string; model?: string; level: "local" | "strong" }; evidenceIds: string[] };
export type TaskEffect = { key: string; description: string; check: TaskCheck };
export type EffectRecord = TaskEffect & { state: "pending" | "started" | "unknown" | "confirmed"; attempt?: number; startedAt?: string; checkedAt?: string; detail?: string };
export type ReviewRun = { id: string; executor: string; model?: string; level: "local" | "strong"; startedAt: string; endedAt?: string; outcome?: string; pid?: number; pidImage?: string; error?: string; response?: string; leaseId?: string; usage?: Record<string, number>; cost?: { tier: "local" | "subscription"; providerCost: 0 } };

export type TaskKind = "code_edit" | "code_review" | "text" | "analysis" | "agent_tool";

/** The delegation contract an agent submits. */
export type TaskSpec = {
  title?: string;
  goal: string;
  expectedResult?: string;
  criteria?: TaskCriterion[];
  effects?: TaskEffect[];
  retry?: { maxAttempts?: number; sameFailureLimit?: number; delayMs?: number; maxDelayMs?: number };
  review?: { forceStrong?: boolean; timeoutMs?: number; maxRuns?: number; allowUnknownSubscriptionQuota?: boolean };
  resourceLimits?: { vramMiB?: number; ramMiB?: number; cpuSlots?: number };
  actor?: string;
  tools?: string[];
  acceptance?: string[];
  checks?: TaskCheck[];
  inputs?: string[];
  workspace?: string;
  isolation?: "shared" | "worktree";
  constraints?: string[];
  permissions?: { fileWrite?: boolean; shell?: "none" | "tests" | "workspace"; network?: boolean };
  budget?: { wallMinutes?: number; subscriptionRuns?: number; maxTurns?: number; providerCost?: number };
  priority?: number;
  executor?: string;
  allowedExecutors?: string[];
  requirements?: { kind?: TaskKind; quality?: "basic" | "normal" | "high"; contextTokens?: number };
  idempotencyKey?: string;
  parentTaskId?: string;
  onPartial?: "block" | "continue";
  allowDuplicate?: boolean;
};

export type CheckResult = { check: TaskCheck; ok: boolean; detail: string; durationMs: number; content?: string; truncated?: boolean; observedAt?: string; source?: string };

export type Attempt = {
  n: number;
  executor: string;
  startedAt: string;
  endedAt?: string;
  pid?: number;
  pidImage?: string;
  outcome?: "succeeded" | "failed" | "cancelled" | "unknown";
  failureClass?: FailureClass;
  error?: string;
  sessionId?: string;
  model?: string;
  baseline?: WorkspaceSnapshot;
  changedFiles?: string[];
  strategy?: string;
  provider?: string;
  modelCalls?: ModelCall[];
  toolCalls?: AgentToolCall[];
  requestedModel?: string;
  resourceWait?: boolean;
};

export type WorkspaceSnapshot = { kind: "git" | "files" | "none"; head?: string; entries: Record<string, string>; capturedAt: string; truncated?: boolean };

export type TaskChain = {
  rootTaskId: string;
  parentTaskId?: string;
  depth: number;
  agents: string[];
  fingerprints: string[];
};

export type TaskResult = {
  summary: string;
  executor: string;
  model?: string;
  provider?: string;
  changedFiles: string[];
  checks: CheckResult[];
  workdir?: string;
  branch?: string;
  artifactPath?: string;
  usage?: Record<string, number>;
  cost: { tier: "local" | "subscription"; providerCost: 0; note: string };
};

export type AgentTask = {
  id: string;
  spec: TaskSpec;
  title: string;
  state: TaskState;
  reason: string;
  agentId: string;
  chain: TaskChain;
  fingerprint: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  executor?: string;
  excludedExecutors: Record<string, string>;
  attempts: Attempt[];
  workdir?: string;
  worktree?: { path: string; branch: string; repo: string };
  lockKeys: string[];
  leaseId?: string;
  cancelRequestedAt?: string;
  result?: TaskResult;
  contract?: TaskContract;
  evidence?: TaskEvidence[];
  reviews?: AcceptanceReview[];
  reviewRuns?: ReviewRun[];
  effects?: EffectRecord[];
  nextAttemptAt?: string;
  reviewPending?: boolean;
  pauseRequestedAt?: string;
  nextStep?: string;
  strategy?: string;
  dependsOn?: string[];
};

export type TaskEvent = { at: string; type: string; message: string; data?: Record<string, unknown> };

export type AgentKind = "owner" | "mcp" | "persona" | "app" | "task";

export type AgentPolicy = {
  id: string;
  allowedExecutors: string[];
  maxDelegationDepth: number;
  chainBudget: { tasks: number; wallMinutes: number; subscriptionRuns: number };
  workspaceRoots: string[];
  maxPriority: number;
  canSetComputerMode: boolean;
  canUseHeavyGpu: boolean;
  dailyTaskLimit: number;
};

export type AgentIdentity = { id: string; kind: AgentKind; label: string; policy: AgentPolicy; taskId?: string };
