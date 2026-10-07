import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DecisionExecutor } from "@snarkroute/core";
import type { NodeRunner, NodeRunnerResult } from "@snarkroute/executor";
import { createModelResolver } from "@snarkroute/openrouter";
import type { OpenRoute, RouteNode } from "@snarkroute/protocol";
import { createRemoteTextNodeRunner, loadModelRouteMappings } from "../execution/model-gateway-runners";
import { loadLiveModelCatalogV1 } from "../routes/models";
import { modelOptionsForNodeV1 } from "../services/model-catalog-v1";
import { selectSemanticModelOptionV1 } from "../services/semantic-model-selection";
import { JabberwockMemoryService } from "./service";
import { AtomicAgentRuntimeError, SnarkRouteAtomicAgentRuntime } from "./atomic-agent-runtime";
import { BoundedVerifierRuntime } from "./bounded-verifier";
import type { AtomicToolResult } from "./atomic-tools";
import type { AtomicPermissions } from "./atomic-tools";
import type { NativeMessage, NativeToolDefinition, ToolProtocol } from "./native-tools";
import { localOpenAiConfigs } from "../providers/local-openai";
import type { Artifact, Decision, Fact, Step } from "./types";
import type { RepairAttempt } from "./repair-target";

export type SupervisorRoutingMode = "default" | "auto" | "fixed";
export type SupervisorRuntimeMode = "text" | "agent";

export interface SupervisorGetStateResult {
  taskId: string;
  project: {
    id: string;
    name: string;
    description: string;
    rootPath: string;
    updatedAt: string;
  };
  goal: {
    title: string;
    originalRequest: string;
    status: string;
    updatedAt: string;
  };
  facts: Fact[];
  decisions: Decision[];
  completedSteps: Step[];
  activeSteps: Step[];
  failedSteps: Step[];
  artifacts: Artifact[];
}

export interface SupervisorExecuteStepInput {
  taskId: string;
  instruction: string;
  signal?: AbortSignal;
  routingMode?: SupervisorRoutingMode;
  model?: string;
  runtimeMode?: SupervisorRuntimeMode;
  permissions?: AtomicPermissions;
  maxToolTurns?: number;
  toolProtocol?: ToolProtocol;
  expectedOutput?: string;
  constraints?: string[] | Record<string, unknown>;
  /** Internal Route Runner use: reuse the persisted Step, append a Run. */
  stepId?: string;
  routeId?: string;
  phase?: "execution" | "verification";
  executionKind?: "action" | "repair";
  repairAttempt?: RepairAttempt;
  verification?: { evidence: string[]; counterevidence: string[]; toolEvidence: AtomicToolResult[] };
}

export interface SupervisorRoutingResult {
  mode: SupervisorRoutingMode;
  model: string;
  provider?: string;
  providerModelId?: string;
  score?: number;
  reason?: string;
  escalated?: boolean;
  retries?: number;
  metadata?: Record<string, unknown>;
}

export interface SupervisorStepResult {
  taskId: string;
  stepId: string;
  sequence: number;
  status: "completed" | "failed";
  routing: SupervisorRoutingResult;
  summary: string;
  response: string;
  artifacts?: Artifact[];
  error?: string;
  failureStage?: "routing" | "runtime";
}

export interface SupervisorRouteRequest {
  routingMode: Exclude<SupervisorRoutingMode, "default">;
  model?: string;
  instruction: string;
  contextPacket: string;
  signal?: AbortSignal;
}

export interface SupervisorModelRouter {
  route(request: SupervisorRouteRequest): Promise<SupervisorRoutingResult>;
}

export interface SupervisorAgentRuntimeResult {
  response: string;
  assistantMessage?: unknown;
  summary?: string;
  artifacts?: Array<{ path: string; description?: string }>;
  routing?: Partial<SupervisorRoutingResult>;
  metadata?: Record<string, unknown>;
}

export interface SupervisorAgentRuntime {
  execute(input: {
    taskId: string;
    stepId: string;
    instruction: string;
    contextPacket: string;
    routing: SupervisorRoutingResult;
    rootPath: string;
    permissions: AtomicPermissions;
    maxToolTurns?: number;
    toolProtocol?: ToolProtocol;
    chat?: { messages: NativeMessage[]; tools: NativeToolDefinition[]; toolChoice: "auto" | "none" };
    signal?: AbortSignal;
    phase?: "execution" | "verification";
    verification?: SupervisorExecuteStepInput["verification"];
    generation?: { maxTokens: number; temperature: number; jsonObject?: boolean };
    onProgress?: (metadata: Record<string, unknown>) => void;
  }): Promise<SupervisorAgentRuntimeResult>;
}

export interface SupervisorRecordAssessmentInput {
  taskId: string;
  stepId: string;
  assessment: string;
  accepted: boolean;
  facts?: Array<string | { text: string; source?: string }>;
  decisions?: Array<string | { text: string; rationale?: string }>;
}

export interface SupervisorBridgeOptions {
  router?: SupervisorModelRouter;
  runtime?: SupervisorAgentRuntime;
  textRuntime?: SupervisorAgentRuntime;
  verificationRuntime?: SupervisorAgentRuntime;
  decisionExecutor?: DecisionExecutor;
}

export class SupervisorBridge {
  private readonly router: SupervisorModelRouter;
  private readonly runtime: SupervisorAgentRuntime;
  private readonly textRuntime: SupervisorAgentRuntime;
  private readonly verificationRuntime: SupervisorAgentRuntime;

  constructor(private readonly memory: JabberwockMemoryService, options: SupervisorBridgeOptions = {}) {
    this.router = options.router ?? new SnarkRouteSupervisorModelRouter(options.decisionExecutor);
    this.textRuntime = options.textRuntime ?? options.runtime ?? new SnarkRouteAtomicTextRuntime();
    this.runtime = options.runtime ?? new SnarkRouteAtomicAgentRuntime(this.textRuntime);
    this.verificationRuntime = options.verificationRuntime ?? options.runtime ?? new BoundedVerifierRuntime(this.textRuntime);
  }

  supervisorGetState(taskId: string): SupervisorGetStateResult {
    const context = this.memory.get_task_context(required(taskId, "Task id"));
    if (!context) throw new Error(`Task "${taskId}" was not found.`);
    return {
      taskId: context.task_goal.id,
      project: {
        id: context.project_summary.id,
        name: context.project_summary.name,
        description: context.project_summary.description,
        rootPath: context.project_summary.root_path,
        updatedAt: context.project_summary.updated_at
      },
      goal: {
        title: context.task_goal.title,
        originalRequest: context.task_goal.original_request,
        status: context.task_goal.status,
        updatedAt: context.task_goal.updated_at
      },
      facts: context.relevant_facts,
      decisions: context.decisions,
      completedSteps: context.completed_steps,
      activeSteps: context.active_pending_steps,
      failedSteps: this.memory.list_task_steps(taskId).filter((step) => ["failed", "cancelled", "rejected"].includes(step.status)),
      artifacts: context.artifacts
    };
  }

  get boundedVerification(): boolean { return this.verificationRuntime instanceof BoundedVerifierRuntime; }

  async supervisorExecuteStep(input: SupervisorExecuteStepInput): Promise<SupervisorStepResult> {
    const taskId = required(input.taskId, "Task id");
    const instruction = required(input.instruction, "Step instruction");
    const routingMode = input.routingMode ?? "default";
    const model = routingMode === "default" ? this.memory.get_setting("jabberwock.defaultModel")?.trim() : input.model?.trim();
    const routerRoutingMode: Exclude<SupervisorRoutingMode, "default"> = routingMode === "default" ? "fixed" : routingMode;
    const runtimeMode = input.runtimeMode ?? "text";
    const permissions = input.permissions ?? "read_only";
    if (routingMode !== "default" && routingMode !== "auto" && routingMode !== "fixed") throw new Error(`Unsupported routing mode "${routingMode}".`);
    if (runtimeMode !== "text" && runtimeMode !== "agent") throw new Error(`Unsupported runtime mode "${runtimeMode}".`);
    if (permissions !== "read_only" && permissions !== "read_write") throw new Error(`Unsupported permission mode "${permissions}".`);
    if (routingMode === "fixed" && !input.model?.trim()) throw new Error("Model is required in fixed routing mode.");
    if (!this.memory.get_task(taskId)) throw new Error(`Task "${taskId}" was not found.`);
    if (this.memory.project_has_running_route(taskId, input.routeId)) throw new Error("PROJECT_BUSY: A route is already running in this project.");

    const step = input.stepId ? this.memory.get_step(input.stepId)
      : this.memory.create_step({ task_id: taskId, sequence: this.memory.next_step_sequence(taskId), instruction, status: "active" });
    if (!step || step.task_id !== taskId) throw new Error("Step does not belong to this task.");
    if (input.stepId && !this.memory.get_route(input.routeId ?? "")?.steps.some(candidate => candidate.id === step.id)) {
      throw new Error("Existing steps can only be executed by their owning Route Runner.");
    }
    const sequence = step.sequence;
    const state = this.supervisorGetState(taskId);
    const contextPacket = buildSupervisorContextPacket(state, {
      instruction,
      constraints: input.constraints,
      expectedOutput: input.expectedOutput
    });
    const startedAt = new Date().toISOString();
    let routing: SupervisorRoutingResult = {
      mode: routingMode,
      model: model || "unselected"
    };
    let failureStage: "routing" | "runtime" = "routing";
    const run = this.memory.add_run({ step_id: step.id, model: routing.model, prompt: contextPacket,
      response: "", status: "running", metadata: runMetadata(routing, { runtimeMode, permissions, phase: input.phase, executionKind: input.executionKind, ...input.repairAttempt }), started_at: startedAt });
    let progress: Record<string, unknown> = {};

    try {
      throwIfAborted(input.signal);
      if (routingMode === "default" && !model) throw new Error("DEFAULT_MODEL_NOT_CONFIGURED: Jabberwock default model is not configured.");
      const selectedRouting = await this.router.route({
        routingMode: routerRoutingMode,
        model,
        instruction,
        contextPacket,
        signal: input.signal
      });
      throwIfAborted(input.signal);
      routing = { ...selectedRouting, mode: routingMode, model: required(selectedRouting.model, "Routed model") };
      failureStage = "runtime";
      const execution = await (input.phase === "verification" ? this.verificationRuntime : runtimeMode === "agent" ? this.runtime : this.textRuntime).execute({
        taskId, stepId: step.id, instruction, contextPacket, routing,
        rootPath: state.project.rootPath, permissions, maxToolTurns: input.maxToolTurns, toolProtocol: input.toolProtocol,
        signal: input.signal, phase: input.phase, verification: input.verification,
        onProgress: metadata => {
          progress = metadata;
          this.memory.update_run(run.id, { metadata: runMetadata(routing, { runtimeMode, permissions, phase: input.phase, executionKind: input.executionKind, ...metadata, ...input.repairAttempt }) });
        }
      });
      throwIfAborted(input.signal);
      routing = mergeRouting(routing, execution.routing);
      const summary = compactSummary(execution.summary ?? execution.response);
      const artifacts = (execution.artifacts ?? []).map((artifact) => this.memory.add_artifact({
        task_id: taskId,
        step_id: step.id,
        path: required(artifact.path, "Artifact path"),
        description: artifact.description?.trim() ?? ""
      }));
      this.memory.update_run(run.id, {
        model: routing.model,
        response: execution.response,
        status: "completed",
        metadata: runMetadata(routing, { runtimeMode, permissions, phase: input.phase, executionKind: input.executionKind, ...progress, ...(execution.metadata ?? {}), ...input.repairAttempt }),
        finished_at: new Date().toISOString()
      });
      if (!input.routeId) this.memory.complete_step(step.id, summary);
      return {
        taskId,
        stepId: step.id,
        sequence,
        status: "completed",
        routing,
        summary,
        response: execution.response,
        ...(artifacts.length ? { artifacts } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.memory.update_run(run.id, {
        model: routing.model,
        response: message,
        status: "failed",
        metadata: runMetadata(routing, { runtimeMode, permissions, phase: input.phase, executionKind: input.executionKind, error: message, ...progress,
          ...(error instanceof AtomicAgentRuntimeError ? error.metadata : {}), ...input.repairAttempt }),
        finished_at: new Date().toISOString()
      });
      if (!input.routeId) this.memory.fail_step(step.id, compactSummary(message));
      return {
        taskId,
        stepId: step.id,
        sequence,
        status: "failed",
        routing,
        summary: compactSummary(message),
        response: "",
        error: message,
        failureStage
      };
    }
  }

  supervisorRecordAssessment(input: SupervisorRecordAssessmentInput): {
    step: Step;
    facts: Fact[];
    decisions: Decision[];
  } {
    const taskId = required(input.taskId, "Task id");
    const stepId = required(input.stepId, "Step id");
    const task = this.memory.get_task(taskId);
    if (!task) throw new Error(`Task "${taskId}" was not found.`);
    const step = this.memory.get_step(stepId);
    if (!step || step.task_id !== taskId) throw new Error(`Step "${stepId}" does not belong to task "${taskId}".`);
    const assessment = required(input.assessment, "Assessment");
    const updatedStep = this.memory.record_step_assessment(stepId, assessment, input.accepted);
    const facts = (input.facts ?? []).map((fact) => {
      const normalized = typeof fact === "string" ? { text: fact } : fact;
      return this.memory.add_fact({
        project_id: task.project_id,
        task_id: taskId,
        text: required(normalized.text, "Fact text"),
        source: normalized.source?.trim() || "supervisor_assessment"
      });
    });
    const decisions = (input.decisions ?? []).map((decision) => {
      const normalized = typeof decision === "string" ? { text: decision } : decision;
      return this.memory.add_decision({
        project_id: task.project_id,
        task_id: taskId,
        text: required(normalized.text, "Decision text"),
        rationale: normalized.rationale?.trim() || assessment
      });
    });
    return { step: updatedStep, facts, decisions };
  }
}

export class SnarkRouteSupervisorModelRouter implements SupervisorModelRouter {
  constructor(private readonly decisionExecutor?: DecisionExecutor) {}

  async route(request: SupervisorRouteRequest): Promise<SupervisorRoutingResult> {
    throwIfAborted(request.signal);
    const catalog = await loadLiveModelCatalogV1("ai.text");
    throwIfAborted(request.signal);
    const options = modelOptionsForNodeV1("ai.text", catalog);
    const selection = await selectSemanticModelOptionV1(options, {
      nodeType: "ai.text",
      prompt: request.contextPacket,
      inputs: { text: true },
      manualModelRef: request.routingMode === "fixed" ? request.model : undefined
    }, this.decisionExecutor);
    throwIfAborted(request.signal);
    if (selection.status !== "ok" || !selection.selection) {
      const reason = selection.trace.policyReasons.join("; ") || "No compatible text model route is available.";
      throw new Error(request.routingMode === "fixed" ? `Fixed model could not be resolved: ${reason}` : `Automatic model routing failed: ${reason}`);
    }
    const selected = selection.selection;
    return {
      mode: request.routingMode,
      model: selected.providerModelId,
      provider: selected.provider,
      providerModelId: selected.providerModelId,
      reason: [selection.trace.selectionReason, ...selection.trace.policyReasons].join(": "),
      metadata: {
        engineId: selected.engineId,
        catalogModelId: selected.modelId,
        storedModelId: selected.storedModelId,
        nativeToolsConfirmed: selected.provider === "local_openai" && localOpenAiConfigs().some(config => config.nativeToolModelIds?.includes(selected.providerModelId)),
        requirements: selection.requirements,
        trace: selection.trace
      }
    };
  }
}

export class SnarkRouteAtomicTextRuntime implements SupervisorAgentRuntime {
  private runner?: Promise<NodeRunner>;

  async execute(input: Parameters<SupervisorAgentRuntime["execute"]>[0]): Promise<SupervisorAgentRuntimeResult> {
    const runner = await (this.runner ??= this.createRunner());
    const node: RouteNode = { id: input.stepId, type: "ai.text", title: "Jabberwock supervisor step" };
    const route: OpenRoute = {
      routeVersion: "1.0",
      route: { id: `supervisor_${input.stepId}`, title: "Jabberwock supervisor step", author: { name: "Jabberwock" } },
      nodes: [node],
      edges: []
    };
    const result = await runner({
      node,
      params: {
        model: stringMetadata(input.routing.metadata, "catalogModelId") ?? input.routing.model,
        executionProvider: input.routing.provider,
        providerModelId: input.routing.providerModelId ?? input.routing.model,
        prompt: input.contextPacket,
        ...(input.chat ? { messages: input.chat.messages, tools: input.chat.tools, tool_choice: input.chat.toolChoice } : {}),
        ...(input.generation ? { max_tokens: input.generation.maxTokens, temperature: input.generation.temperature,
          ...(input.generation.jsonObject ? { response_format: { type: "json_object" } } : {}) } : {})
      },
      inputs: {},
      context: {
        runId: `supervisor_${randomUUID()}`,
        route,
        outputDirectory: join(process.cwd(), "data", "jabberwock", "runtime"),
        nodeOutputs: {},
        log: () => undefined,
        signal: input.signal
      }
    });
    return {
      response: responseText(result.output),
      ...(input.chat ? { assistantMessage: record(result.output).assistant_message } : {}),
      routing: routingFromRuntime(result, input.routing),
      metadata: runtimeMetadata(result)
    };
  }

  private async createRunner(): Promise<NodeRunner> {
    return createRemoteTextNodeRunner(createModelResolver(await loadModelRouteMappings()));
  }
}

export function buildSupervisorContextPacket(
  state: SupervisorGetStateResult,
  current: Pick<SupervisorExecuteStepInput, "instruction" | "constraints" | "expectedOutput">
): string {
  const facts = recent(state.facts, 20).map((fact) => `- ${compact(fact.text, 500)}`);
  const decisions = recent(state.decisions, 16).map((decision) => `- ${compact(decision.text, 500)} (${compact(decision.rationale, 300)})`);
  const completed = recent(state.completedSteps, 20).map((step) => `${step.sequence}. ${compact(step.result_summary ?? step.instruction, 600)}`);
  const artifacts = recent(state.artifacts, 20).map((artifact) => `- ${compact(artifact.path, 500)}${artifact.description ? ` — ${compact(artifact.description, 300)}` : ""}`);
  const constraints = constraintLines(current.constraints);
  return [
    "PROJECT",
    compact(state.project.name, 300),
    compact(state.project.description, 800),
    compact(state.project.rootPath, 500),
    "",
    "TASK GOAL",
    compact(state.goal.originalRequest, 2_000),
    "",
    "KNOWN FACTS",
    ...(facts.length ? facts : ["- none"]),
    "",
    "DECISIONS",
    ...(decisions.length ? decisions : ["- none"]),
    "",
    "COMPLETED STEPS",
    ...(completed.length ? completed : ["- none"]),
    "",
    "RELEVANT ARTIFACTS",
    ...(artifacts.length ? artifacts : ["- none"]),
    "",
    "CURRENT INSTRUCTION",
    compact(required(current.instruction, "Step instruction"), 4_000),
    "",
    "CONSTRAINTS",
    ...(constraints.length ? constraints : ["- none"]),
    "",
    "EXPECTED OUTPUT",
    current.expectedOutput?.trim() ? `- ${compact(current.expectedOutput, 2_000)}` : "- not specified"
  ].join("\n");
}

function mergeRouting(base: SupervisorRoutingResult, update: Partial<SupervisorRoutingResult> | undefined): SupervisorRoutingResult {
  if (!update) return base;
  return { ...base, ...update, mode: base.mode, metadata: { ...(base.metadata ?? {}), ...(update.metadata ?? {}) } };
}

function runMetadata(routing: SupervisorRoutingResult, runtime: Record<string, unknown> | undefined): Record<string, unknown> {
  return jsonRecord({ routing, ...(runtime ? { runtime } : {}) });
}

function runtimeMetadata(result: NodeRunnerResult): Record<string, unknown> {
  return jsonRecord({
    ...(result.logs?.length ? { logs: result.logs } : {}),
    ...(result.metrics ? { metrics: result.metrics } : {}),
    ...(result.provenance ? { provenance: result.provenance } : {}),
    ...(result.providerUsage ? { providerUsage: result.providerUsage } : {})
  });
}

function routingFromRuntime(result: NodeRunnerResult, fallback: SupervisorRoutingResult): Partial<SupervisorRoutingResult> {
  const output = record(result.output);
  const provenance = record(result.provenance);
  const provider = stringValue(output.provider) ?? stringValue(provenance.provider) ?? fallback.provider;
  const model = stringValue(output.model) ?? stringValue(provenance.model) ?? fallback.model;
  return { provider, model, providerModelId: model };
}

function responseText(output: unknown): string {
  if (typeof output === "string") return output;
  const value = record(output);
  const text = stringValue(value.text) ?? stringValue(value.content) ?? stringValue(value.response);
  return text ?? JSON.stringify(output);
}

function compactSummary(value: string): string {
  return compact(value.replace(/\s+/g, " ").trim(), 1_000);
}

function constraintLines(value: SupervisorExecuteStepInput["constraints"]): string[] {
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter(Boolean).slice(0, 20).map((entry) => `- ${compact(entry, 500)}`);
  if (!value) return [];
  return Object.entries(value).slice(0, 20).map(([key, nested]) => `- ${compact(key, 100)}: ${compact(safeString(nested), 500)}`);
}

function recent<T>(values: T[], limit: number): T[] {
  return values.slice(Math.max(0, values.length - limit));
}

function compact(value: string, limit: number): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  return stringValue(metadata?.[key]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested)) as Record<string, unknown>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "Supervisor request was aborted.");
  error.name = "AbortError";
  throw error;
}
