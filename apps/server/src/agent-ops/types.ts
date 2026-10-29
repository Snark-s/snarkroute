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
  | "verification";

export type TaskCheck =
  | { type: "command"; command: string; args?: string[]; timeoutMs?: number }
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string };

export type TaskKind = "code_edit" | "code_review" | "text" | "analysis";

/** The delegation contract an agent submits. */
export type TaskSpec = {
  title?: string;
  goal: string;
  acceptance?: string[];
  checks?: TaskCheck[];
  inputs?: string[];
  workspace?: string;
  isolation?: "shared" | "worktree";
  constraints?: string[];
  permissions?: { fileWrite?: boolean; shell?: "none" | "tests" | "workspace"; network?: boolean };
  budget?: { wallMinutes?: number; subscriptionRuns?: number; maxTurns?: number };
  priority?: number;
  executor?: string;
  allowedExecutors?: string[];
  requirements?: { kind?: TaskKind; quality?: "basic" | "normal" | "high"; contextTokens?: number };
  idempotencyKey?: string;
  parentTaskId?: string;
  onPartial?: "block" | "continue";
  allowDuplicate?: boolean;
};

export type CheckResult = { check: TaskCheck; ok: boolean; detail: string; durationMs: number };

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
