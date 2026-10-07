import type { SupervisorExecuteStepInput } from "./supervisor-bridge";
import type { Step } from "./types";
import type { VerificationPolicy } from "./verification-policy";
import type { RepairTarget } from "./repair-target";

export type RouteStatus = "pending" | "running" | "completed" | "blocked" | "cancelled" | "failed";
export type RouteStepStatus = "pending" | "running" | "completed" | "retrying" | "blocked" | "failed" | "skipped";
export type RouteExecutionConfig = Pick<SupervisorExecuteStepInput, "routingMode" | "model" | "runtimeMode" | "permissions" | "maxToolTurns" | "toolProtocol" | "constraints"> & {
  /** Explicitly allow bounded workspace remediation under these existing Step IDs. */
  correctiveExecution?: { stepIndexes: number[] };
};
export interface RouteVerificationConfig {
  timeoutMs?: number;
  executionConfig?: Pick<SupervisorExecuteStepInput, "routingMode" | "model" | "constraints">;
  policies?: VerificationPolicy[];
}
export interface RouteBlock {
  kind?: "coding_escalation" | "external_decision" | "verification";
  escalation?: CodingEscalationPacket;
  code: string;
  blockedReason: string;
  failedStep: string | null;
  attempts: number;
  evidence: string[];
  question: string;
  possibleOptions?: string[];
  repairTarget?: RepairTarget;
  targetAttempts?: number;
  model?: string;
  toolsUsed?: string[];
}
export interface ExternalResolution {
  stepId: string;
  evidence: string[];
  changedFiles: string[];
}
export interface CodingEscalationPacket {
  routeId: string; taskId: string; stepId: string; instruction: string;
  originalGoal: string; acceptanceCriteria: string[]; reason: string;
  repairTarget?: RepairTarget; expectedCondition?: RepairTarget["expectedCondition"];
  counterevidence: string[]; relevantSourcePaths: string[]; changedFiles: string[];
  model?: string; protocol?: string;
  localAttempts: Array<{ runId: string; model: string; status: string; summary: string; tools: unknown; results: unknown; targetResolved: unknown; noProgress: unknown }>;
  relevantDecisions: Array<{ id: string; text: string; rationale: string }>;
  recommendedVerification: { instruction: string; acceptanceCriteria: string[]; policy: VerificationPolicy | null };
}
export interface RouteStep extends Omit<Step, "status"> {
  routeId: string;
  index: number;
  title: string;
  acceptanceCriteria: string[];
  status: RouteStepStatus;
  attempts: number;
  maxAttempts: number;
  dependencies: number[];
  needsVerification: boolean;
  error: string | null;
  recoveryResolution: string | null;
}
export interface WorkingRoute {
  id: string;
  taskId: string;
  status: RouteStatus;
  currentStep: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  blockedReason: RouteBlock | null;
  summary: string | null;
  executionConfig: RouteExecutionConfig;
  verificationConfig?: RouteVerificationConfig;
  steps: RouteStep[];
}
export interface CreateRouteInput {
  taskId: string;
  steps: Array<{ title: string; instruction: string; acceptanceCriteria: string[]; maxAttempts?: number; dependencies?: number[] }>;
  executionConfig?: RouteExecutionConfig;
  verificationConfig?: RouteVerificationConfig;
  autoStart?: boolean;
}
export type RouteUpdate = Partial<Pick<WorkingRoute, "status" | "currentStep" | "startedAt" | "completedAt" | "blockedReason" | "summary" | "executionConfig" | "verificationConfig">>;
export type RouteStepUpdate = Partial<Pick<RouteStep, "status" | "attempts" | "maxAttempts" | "needsVerification" | "error" | "recoveryResolution">>;
