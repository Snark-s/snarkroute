import { EventEmitter } from "node:events";
import { z } from "zod";
import { AtomicWorkspaceTools } from "./atomic-tools";
import type { MutationEvent } from "./atomic-agent-runtime";
import { continueRouteSchema, createRouteSchema, routeExecutionConfigSchema } from "./route-input";
import type { CreateRouteInput, RouteBlock, RouteStep, WorkingRoute, RouteExecutionConfig, RouteVerificationConfig, ExternalResolution, CodingEscalationPacket } from "./route-types";
import { inspectVerificationPolicy } from "./verification-policy";
import { repairTargetSchema, selectRepairTarget, targetMadeProgress, type RepairAttempt, type RepairTarget } from "./repair-target";
import { JabberwockMemoryService } from "./service";
import { SupervisorBridge, type SupervisorStepResult } from "./supervisor-bridge";

const assessmentSchema = z.object({
  verdict: z.enum(["accepted", "retry", "blocked", "unknown"]),
  summary: z.string().trim().min(1).max(4_000),
  evidence: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
  counterevidence: z.array(z.string().trim().min(1).max(2_000)).max(20).optional(),
  workspaceRepairable: z.boolean().optional(),
  repairTargets: z.array(repairTargetSchema).optional(),
  safeToRetry: z.boolean().optional(), code: z.string().max(100).optional(),
  question: z.string().max(2_000).optional(), possibleOptions: z.array(z.string().max(1_000)).max(10).optional()
});
type Assessment = z.infer<typeof assessmentSchema>;
const externalBlockCodes = new Set(["architecture_choice", "contradictory_requirements", "credential_required", "authorization_required", "user_choice", "missing_resource", "invalid_plan", "scope_exceeded"]);
const codingBlockCodes = new Set(["repair_target_stalled", "repair_target_regressed", "max_attempts", "external_resolution_rejected", "external_resolution_unverified"]);
// Ownership registry only; scheduling and inference limits remain in the existing runtime.
const ownedRoutes = new Map<string, { controller: AbortController; promise: Promise<void> }>();

export class RouteRunnerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Orchestrates persisted Supervisor Steps; model/provider concurrency stays in the existing runtime. */
export class RouteRunner {
  readonly events = new EventEmitter();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly recoveryWaiting = new Set<string>();
  private closing = false;
  constructor(private readonly memory: JabberwockMemoryService, private readonly bridge: SupervisorBridge) {}

  create_route(input: CreateRouteInput): WorkingRoute {
    const parsed = createRouteSchema.parse(input);
    if (!this.memory.get_task(parsed.taskId)) throw new RouteRunnerError("TASK_NOT_FOUND", "Task was not found.");
    if (this.memory.project_has_running_route(parsed.taskId) && parsed.autoStart !== false) throw new RouteRunnerError("PROJECT_BUSY", "Another route is running in this project.");
    const route = this.memory.create_route({ ...parsed, executionConfig: { runtimeMode: "agent", permissions: "read_only", maxToolTurns: 16, ...parsed.executionConfig } });
    if (parsed.autoStart !== false) {
      try { this.start_route(route.id); } catch (error) {
        // A rejected creation must not execute unexpectedly during startup recovery.
        this.memory.update_route(route.id, { status: "failed", completedAt: now(),
          summary: (error instanceof Error ? error.message : String(error)).slice(0, 1_000) });
        throw error;
      }
    }
    return this.requireRoute(route.id);
  }

  start_route(routeId: string): WorkingRoute {
    const route = this.requireRoute(routeId);
    if (this.closing) throw new RouteRunnerError("SHUTTING_DOWN", "Supervisor is shutting down.");
    if (route.status === "running" || route.status === "completed") return route;
    if (route.status !== "pending") throw new RouteRunnerError("ROUTE_CONFLICT", "Only pending routes can be started. Use continue_route for BLOCKED routes.");
    if (!this.memory.claim_route(routeId)) throw new RouteRunnerError("PROJECT_BUSY", "Another execution is active in this project.");
    const controller = new AbortController();
    // Register ownership before the asynchronous loop can yield.
    const entry = { controller, promise: Promise.resolve() };
    this.active.set(routeId, entry);
    ownedRoutes.set(routeId, entry);
    entry.promise = Promise.resolve().then(() => this.run(routeId, controller.signal)).catch(error => {
      if (this.requireRoute(routeId).status === "cancelled") return;
      const message = error instanceof Error ? error.message : String(error);
      this.memory.update_route(routeId, { status: "failed", summary: message.slice(0, 1_000), completedAt: now() });
      this.publish(routeId);
    }).finally(() => { this.active.delete(routeId); ownedRoutes.delete(routeId); });
    this.publish(routeId);
    return this.requireRoute(routeId);
  }

  get_route_state(routeId: string) {
    const route = this.requireRoute(routeId);
    const state = this.bridge.supervisorGetState(route.taskId);
    const runs = route.steps.flatMap(step => this.memory.list_runs_for_step(step.id));
    const metadata = runs.map(run => record(run.metadata.runtime));
    const changedFiles = [...new Set(metadata.flatMap(meta => [...mutations(meta).filter(event => event.tool !== "shell.exec" && ((event.state === "finished" && event.success) || event.verification === "applied")).map(event => event.path).filter((path): path is string => Boolean(path)),
      ...(meta.executionKind === "external_resolution" && meta.externalVerification === "accepted" && Array.isArray(meta.changedFiles) ? meta.changedFiles.map(String) : [])]))];
    const validation = metadata.flatMap(meta => Array.isArray(meta.commandSummaries) ? meta.commandSummaries : []).slice(-20);
    return { id: route.id, taskId: route.taskId, status: route.status,
      currentStep: route.steps.find(step => step.id === route.currentStep) ? compactStep(route.steps.find(step => step.id === route.currentStep)!) : null,
      totalSteps: route.steps.length, completedSteps: route.steps.filter(step => ["completed", "skipped"].includes(step.status)).length,
      retries: route.steps.reduce((count, step) => count + Math.max(0, step.attempts - 1), 0),
      steps: route.steps.map(compactStep), blockedReason: route.blockedReason, summary: route.summary,
      escalation: this.get_escalation(routeId),
      createdAt: route.createdAt, startedAt: route.startedAt, completedAt: route.completedAt,
      executionConfig: route.executionConfig, verificationConfig: route.verificationConfig,
      decisions: state.decisions.filter(decision => decision.rationale.includes(`Route ${route.id}:`)).slice(-3),
      verification: runs.filter(run => record(run.metadata.runtime).phase === "verification").slice(-3).map(run => ({ runId: run.id,
        model: run.model, status: run.status, runtime: record(run.metadata.runtime).runtimeMode,
        verdict: record(run.metadata.runtime).verificationVerdict ?? (run.status === "failed" ? "unknown" : undefined),
        durationMs: run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : undefined })),
      artifacts: state.artifacts.filter(artifact => route.steps.some(step => step.id === artifact.step_id)), changedFiles, validation };
  }

  get_escalation(routeId: string): CodingEscalationPacket | null {
    const route = this.requireRoute(routeId);
    if (route.status !== "blocked" || !route.blockedReason || !codingBlockCodes.has(route.blockedReason.code)) return null;
    const step = route.steps.find(value => value.id === route.blockedReason!.failedStep);
    return step ? route.blockedReason.escalation ?? this.escalationPacket(route, step, route.blockedReason) : null;
  }

  continue_route(input: { routeId: string; resolution: string; additionalAttempts?: number; executionConfig?: RouteExecutionConfig; verificationConfig?: RouteVerificationConfig; externalResolution?: ExternalResolution }): WorkingRoute {
    const route = this.requireRoute(input.routeId);
    if (route.status !== "blocked" || this.active.has(route.id)) throw new RouteRunnerError("ROUTE_CONFLICT", "Route must be BLOCKED and its execution stopped.");
    const parsed = continueRouteSchema.safeParse({ resolution: input.resolution, additionalAttempts: input.additionalAttempts, executionConfig: input.executionConfig, verificationConfig: input.verificationConfig, externalResolution: input.externalResolution });
    if (!parsed.success) throw new RouteRunnerError("INVALID_REQUEST", "Invalid resolution or execution configuration.");
    const resolution = parsed.data.resolution;
    const external = parsed.data.externalResolution;
    const step = route.steps.find(candidate => candidate.id === route.blockedReason?.failedStep);
    if (external && (!step || external.stepId !== step.id || !this.get_escalation(route.id)
      || input.additionalAttempts || input.executionConfig || input.verificationConfig)) {
      throw new RouteRunnerError("INVALID_REQUEST", "External resolution must address the escalated step using its existing verification policy and budgets.");
    }
    const executionConfig = routeExecutionConfigSchema.safeParse({ ...route.executionConfig, ...parsed.data.executionConfig });
    if (!executionConfig.success) throw new RouteRunnerError("INVALID_REQUEST", "The continued routing configuration is invalid.");
    if (this.memory.project_has_running_route(route.taskId)) throw new RouteRunnerError("PROJECT_BUSY", "Another route is running in this project.");
    const task = this.memory.get_task(route.taskId)!;
    this.memory.add_decision({ project_id: task.project_id, task_id: task.id, text: resolution,
      rationale: `Route ${route.id}: ${route.blockedReason?.blockedReason ?? "external resolution"}; additional attempts: ${parsed.data.additionalAttempts ?? 3}${parsed.data.executionConfig ? `; execution configuration: ${JSON.stringify(parsed.data.executionConfig)}` : ""}` });
    if (external && step) this.memory.add_run({ step_id: step.id, model: "external_coding_executor", prompt: JSON.stringify(this.get_escalation(route.id)),
      response: JSON.stringify({ resolution, evidence: external.evidence, changedFiles: external.changedFiles }), status: "completed", finished_at: now(),
      metadata: { runtime: { phase: "execution", executionKind: "external_resolution", externalVerification: "pending", changedFiles: external.changedFiles, evidence: external.evidence } } });
    if (step) this.memory.update_route_step(step.id, { status: "retrying", error: null,
      recoveryResolution: resolution,
      ...(external || executionConfig.data.correctiveExecution ? { needsVerification: true } : {}),
      // Retain lifetime attempts and grant another bounded budget after an explicit decision.
      ...(!external ? { maxAttempts: Math.max(step.maxAttempts, step.attempts + (parsed.data.additionalAttempts ?? 3)) } : {}) });
    this.memory.update_route(route.id, { status: "pending", blockedReason: null, summary: null, completedAt: null, executionConfig: executionConfig.data,
      verificationConfig: { ...route.verificationConfig, ...parsed.data.verificationConfig } });
    return this.start_route(route.id);
  }

  cancel_route(routeId: string): WorkingRoute {
    const route = this.requireRoute(routeId);
    if (["completed", "cancelled", "failed"].includes(route.status)) return route;
    if (route.status === "running" && !ownedRoutes.has(route.id)) throw new RouteRunnerError("ROUTE_CONFLICT", "Cancel through the Supervisor process that owns this running route.");
    this.memory.update_route(route.id, { status: "cancelled", completedAt: now(), summary: "Route cancelled. Completed progress retained." });
    const step = route.steps.find(candidate => candidate.id === route.currentStep);
    if (step && step.status !== "completed") this.memory.update_route_step(step.id, { status: "failed", error: "Route cancelled." });
    ownedRoutes.get(route.id)?.controller.abort(new Error("Route cancelled."));
    this.publish(route.id);
    return this.requireRoute(route.id);
  }

  async wait(routeId: string): Promise<void> { await ownedRoutes.get(routeId)?.promise; }

  recover(): void {
    for (const routeId of this.memory.recover_routes(new Set(ownedRoutes.keys()))) {
      try { this.start_route(routeId); } catch (error) {
        if (error instanceof RouteRunnerError && error.code === "PROJECT_BUSY") {
          this.memory.update_route(routeId, { summary: "Waiting for the active execution in this workspace to finish." });
          this.publish(routeId);
          // Resume on existing ownership completion, without a second scheduler or polling.
          if (ownedRoutes.size && !this.recoveryWaiting.has(routeId)) {
            this.recoveryWaiting.add(routeId);
            void Promise.race([...ownedRoutes.values()].map(entry => entry.promise)).then(() => {
              this.recoveryWaiting.delete(routeId);
              if (!this.closing && this.requireRoute(routeId).status === "pending") this.recover();
            }).catch(() => { this.recoveryWaiting.delete(routeId); });
          }
        } else throw error;
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const entry of this.active.values()) entry.controller.abort(new Error("Supervisor shutting down; verify on restart."));
    await Promise.all([...this.active.values()].map(entry => entry.promise));
    this.events.removeAllListeners();
  }

  private async run(routeId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const route = this.requireRoute(routeId);
      if (route.status !== "running") return;
      const step = route.steps.find(candidate => !["completed", "skipped"].includes(candidate.status));
      if (!step) {
        this.memory.update_route(routeId, { status: "completed", currentStep: null, completedAt: now(),
          summary: route.steps.map(candidate => `${candidate.title}: ${candidate.result_summary ?? "Completed"}`).join("\n").slice(0, 4_000) });
        this.publish(routeId); return;
      }
      if (step.dependencies.some(index => !["completed", "skipped"].includes(route.steps[index]?.status))) {
        this.block(route, step, "invalid_plan", "Step dependencies are unsatisfied.", [], "Resolve the route dependencies."); return;
      }
      this.memory.update_route(routeId, { currentStep: step.id });
      let execution: SupervisorStepResult | undefined;
      if (!step.needsVerification) {
        const rejection = route.executionConfig.correctiveExecution ? this.lastRejection(step) : null;
        if (rejection && !this.canRepair(route, step, rejection.counterevidence, rejection.workspaceRepairable)) return;
        const repairAttempt = rejection ? this.prepareRepair(route, step, rejection) : undefined;
        if (rejection && !repairAttempt) return;
        if (step.attempts >= step.maxAttempts) { this.exhausted(route, step); return; }
        const instruction = repairAttempt ? this.repairInstruction(route, step, repairAttempt) : [step.instruction,
          "Inspect actual state before editing. Fix ordinary local errors yourself. Stay within the given scope.",
          `Acceptance criteria: ${JSON.stringify(step.acceptanceCriteria)}`, `Earlier attempt results: ${this.attemptEvidence(step)}`].join("\n");
        if (rejection && instruction.length > 8_000) {
          this.block(route, step, "scope_exceeded", "Corrective context exceeds the existing bounded instruction size.", rejection.counterevidence,
            "Narrow the step criteria; counterevidence will not be silently truncated."); return;
        }
        this.memory.update_route_step(step.id, { status: "running", attempts: step.attempts + 1, needsVerification: true, error: null });
        this.publish(routeId);
        execution = await this.execute(route, step, signal, "execution", instruction, undefined, rejection ? "repair" : "action", repairAttempt);
        if (execution.status === "failed") this.memory.update_route_step(step.id, { error: execution.error ?? execution.summary });
      }
      if (signal.aborted) break;
      const current = this.requireRoute(routeId).steps.find(candidate => candidate.id === step.id)!;
      const assessment = await this.verify(route, current, signal);
      if (signal.aborted) break;
      this.recordRepairResult(current, assessment);
      const externalRun = this.memory.list_runs_for_step(step.id).filter(run => record(run.metadata.runtime).executionKind === "external_resolution" && record(run.metadata.runtime).externalVerification === "pending").at(-1);
      if (externalRun) {
        const verificationRun = this.memory.list_runs_for_step(step.id).filter(run => record(run.metadata.runtime).phase === "verification").at(-1);
        this.memory.update_run(externalRun.id, { metadata: { ...externalRun.metadata, runtime: { ...record(externalRun.metadata.runtime),
          externalVerification: assessment?.verdict === "accepted" ? "accepted" : assessment ? "rejected" : "unknown", resultVerificationRunId: verificationRun?.id } } });
        if (assessment?.verdict !== "accepted") {
          if (assessment) this.memory.record_step_assessment(step.id, JSON.stringify(assessment), false);
          const reason = assessment?.summary ?? this.requireRoute(route.id).blockedReason?.blockedReason ?? "External resolution could not be verified.";
          const code = assessment ? "external_resolution_rejected" : "external_resolution_unverified";
          const block: RouteBlock = { code, kind: "coding_escalation", blockedReason: reason, failedStep: step.id, attempts: current.attempts,
            evidence: assessment?.counterevidence ?? assessment?.evidence ?? [], question: "Correct the workspace and submit another external resolution for independent verification.",
            ...(assessment?.repairTargets?.length ? { repairTarget: selectRepairTarget(assessment.repairTargets) } : {}) };
          block.escalation = this.escalationPacket(this.requireRoute(route.id), current, block);
          this.memory.update_route_step(step.id, { status: "blocked", error: reason, needsVerification: true });
          this.memory.update_route(route.id, { status: "blocked", blockedReason: block, summary: reason }); this.publish(route.id); return;
        }
      }
      if (!assessment) return;
      if (assessment.verdict === "accepted") {
        this.memory.complete_step(step.id, assessment.summary);
        this.memory.record_step_assessment(step.id, JSON.stringify(assessment), true);
        this.memory.update_route_step(step.id, { status: "completed", needsVerification: false, error: null, recoveryResolution: null });
      } else if (assessment.verdict === "retry" && assessment.safeToRetry) {
        this.memory.record_step_assessment(step.id, JSON.stringify(assessment), false);
        // Retry is a repair of the inspected current state, never a replay of previous tool calls.
        this.memory.add_fact({ project_id: this.memory.get_task(route.taskId)!.project_id, task_id: route.taskId,
          text: `Route step ${step.title}: ${assessment.summary}; ${assessment.evidence.join("; ")}`.slice(0, 2_000), source: "route_verification" });
        this.memory.update_route_step(step.id, { status: "retrying", needsVerification: false, recoveryResolution: null });
        if (route.executionConfig.correctiveExecution && !this.canRepair(route, current, assessment.counterevidence ?? assessment.evidence,
          assessment.workspaceRepairable ?? !assessment.counterevidence)) return;
        // Inspect persisted target history before the general budget so a target stall remains explicit.
        if (route.executionConfig.correctiveExecution) {
          const rejection = this.lastRejection(this.requireRoute(routeId).steps.find(value => value.id === step.id)!);
          if (rejection && !this.prepareRepair(route, current, rejection)) return;
        }
        if (current.attempts >= current.maxAttempts) { this.exhausted(route, current, assessment.evidence); return; }
      } else {
        this.block(route, current, assessment.code ?? "unverified_effects", assessment.summary, assessment.evidence,
          assessment.question ?? "The actual effects could not be verified. Provide the missing evidence or a safe recovery decision.", assessment.possibleOptions); return;
      }
      this.publish(routeId);
    }
    if (this.closing && this.requireRoute(routeId).status === "running") {
      // Keep running on disk so restart recovery marks interrupted work and performs read-only verification.
      this.publish(routeId);
    }
  }

  private async verify(route: WorkingRoute, step: RouteStep, signal: AbortSignal): Promise<Assessment | null> {
    if (signal.aborted) return null;
    const rootPath = this.bridge.supervisorGetState(route.taskId).project.rootPath;
    const executionRuns = this.memory.list_runs_for_step(step.id).filter(run => record(run.metadata.runtime).phase !== "verification");
    const pending = executionRuns.flatMap(run => mutations(record(run.metadata.runtime)).map(event => ({ run, event })))
      .filter(({ event }) => !event.verification && (event.state === "started" || (event.tool === "shell.exec" && event.exitCode === undefined)
        || (event.tool !== "shell.exec" && event.success === false && Boolean(event.afterHash))));
    const actual: string[] = [];
    const verificationErrors: string[] = [];
    let inspectedActualState = false;
    let inconclusiveAssessments = 0;
    const resolved: Array<{ run: typeof executionRuns[number]; event: MutationEvent; state: MutationEvent["verification"] }> = [];
    if (pending.length) {
      const tools = await AtomicWorkspaceTools.create(rootPath, "read_only");
      for (const { run, event } of pending) {
        const state = await tools.verifyMutation(event);
        if (signal.aborted) return null;
        actual.push(`${event.tool} ${event.path ?? ""}: ${state}`);
        if (state === "unknown" && !step.recoveryResolution) {
          this.block(route, step, "unverified_effects", "An interrupted mutation has effects that cannot be established safely.", actual,
            "Confirm the actual effects or supply a safe recovery decision; the write will not be replayed."); return null;
        }
        resolved.push({ run, event, state: state === "unknown" ? "externally_resolved" : state });
      }
    }
    const bounded = this.bridge.boundedVerification;
    let inspection: Awaited<ReturnType<typeof inspectVerificationPolicy>> | undefined;
    const policy = route.verificationConfig?.policies?.find(policy => policy.stepIndex === step.index);
    if (policy) {
      try {
        const commandRuns = policy.commandScope === "route" ? route.steps.flatMap(value => this.memory.list_runs_for_step(value.id)) : executionRuns;
        const commands = commandRuns.filter(run => record(run.metadata.runtime).phase !== "verification")
          .flatMap(run => { const list = record(run.metadata.runtime).commandSummaries; return Array.isArray(list) ? list : []; });
        inspection = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(rootPath, "read_only"), policy, commands);
      } catch (error) {
        this.block(route, step, "verification_unknown", "Required source inspection could not complete.", [String(error)], "Resolve the unavailable verification source."); return null;
      }
    }
    for (let check = 0; check < (bounded ? 1 : 3) && !signal.aborted; check++) {
      const result = await this.execute(route, step, signal, "verification", bounded ? [
        `Verify this instruction: ${step.instruction}`, `Acceptance criteria: ${JSON.stringify(step.acceptanceCriteria)}`,
        `Interrupted-write checks: ${JSON.stringify(actual)}`,
        `Recovery decision: ${step.recoveryResolution ?? "none"}`,
        `Last execution evidence (claims require independent inspection): ${this.attemptEvidence(step, true)}`
      ].join("\n") : [
        `Verify this instruction: ${step.instruction}`, `Acceptance criteria: ${JSON.stringify(step.acceptanceCriteria)}`,
        "Inspect actual state with read/search/diff tools. Validate each criterion using observable evidence, including recorded build/test exits when required.",
        "Return final content as JSON: {verdict: accepted|retry|blocked|unknown, summary: string, evidence: string[], safeToRetry?: boolean, code?: string, question?: string, possibleOptions?: string[]}.",
        "Retry means an incremental repair of the state you just inspected. Do not approve replay of a previous write. If completion cannot be established and retry safety is unknown, return unknown.",
        `BLOCKED codes for external decisions only: ${[...externalBlockCodes].join(", ")}. A normal build/test/patch error is retry, not BLOCKED.`,
        `Deterministic interrupted-write checks: ${JSON.stringify(actual)}`,
        `External recovery resolution (if supplied): ${step.recoveryResolution ?? "none"}. Independently inspect the current state before accepting this resolution or declaring a safe incremental repair.`,
        `Previous runs and tool evidence: ${bounded ? this.attemptEvidence(step, true) : this.attemptEvidence(step)}`
      ].join("\n"), inspection);
      if (inspection) {
        const verificationRun = this.memory.list_runs_for_step(step.id).at(-1)!;
        this.memory.update_run(verificationRun.id, { metadata: { ...verificationRun.metadata, runtime: { ...record(verificationRun.metadata.runtime),
          workspaceInspection: { repairTargets: inspection.repairTargets, evidence: inspection.evidence } } } });
      }
      if (signal.aborted) return null;
      const runtime = record(this.memory.list_runs_for_step(step.id).at(-1)?.metadata.runtime);
      inspectedActualState ||= hasInspection(runtime);
      if (result.status !== "completed") { verificationErrors.push(`Check ${check + 1}: ${result.error ?? result.summary}`.slice(0, 1_000)); continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(result.response.trim().replace(/^```(?:json)?\s*|\s*```$/gu, "")); } catch { verificationErrors.push(`Check ${check + 1}: assessment was not valid JSON.`); continue; }
      const value = record(parsed);
      if (bounded || runtime.boundedVerifier) {
        if (["accepted", "rejected", "unknown"].includes(String(value.verdict)) && typeof value.reason === "string" && Array.isArray(value.counterevidence)) {
          const contradictory = value.verdict === "accepted" && value.counterevidence.length > 0;
          parsed = { verdict: value.verdict === "rejected" || contradictory ? "retry" : value.verdict,
            summary: value.reason, evidence: [...(Array.isArray(value.evidence) ? value.evidence : []), ...value.counterevidence].slice(0, 20),
            counterevidence: value.counterevidence, safeToRetry: true,
            workspaceRepairable: Boolean(inspection?.counterevidence.length) && value.counterevidence.every(value => inspection!.counterevidence.includes(value)) };
        }
      }
      const assessment = assessmentSchema.safeParse(parsed);
      if (!assessment.success) { verificationErrors.push(`Check ${check + 1}: assessment did not satisfy the verdict/evidence schema.`); continue; }
      if (route.executionConfig.runtimeMode === "agent" && !hasInspection(runtime)) { verificationErrors.push(`Check ${check + 1}: no successful inspection evidence.`); continue; }
      const normalized: Assessment = assessment.data.verdict === "blocked" && (!externalBlockCodes.has(assessment.data.code ?? "") || !assessment.data.question?.trim())
        ? { ...assessment.data, verdict: "retry", safeToRetry: true } : assessment.data;
      if (inspection && (normalized.verdict === "accepted" || (normalized.verdict === "retry" && normalized.safeToRetry))) {
        const counterevidence = [...new Set([...(normalized.counterevidence ?? []), ...inspection.counterevidence])];
        if (counterevidence.length) {
          normalized.verdict = "retry"; normalized.safeToRetry = true; normalized.counterevidence = counterevidence;
          normalized.workspaceRepairable = counterevidence.every(value => inspection.counterevidence.includes(value));
          normalized.evidence = [...new Set([...normalized.evidence, ...counterevidence])].slice(0, 20);
        }
      }
      // Only the actual workspace policy can originate targets; model claims and positive evidence cannot.
      normalized.repairTargets = inspection?.repairTargets ?? [];
      if (normalized.verdict === "unknown") {
        inconclusiveAssessments++;
        verificationErrors.push(`Check ${check + 1}: ${normalized.summary}; ${normalized.evidence.join("; ")}`.slice(0, 1_000));
        continue;
      }
      if (normalized.verdict === "accepted" || (normalized.verdict === "retry" && normalized.safeToRetry)) {
        for (const { run, event, state } of resolved) {
          event.verification = state;
          this.memory.update_run(run.id, { metadata: run.metadata });
        }
      }
      return normalized;
    }
    const latestExecution = record(executionRuns.at(-1)?.metadata.runtime);
    if (!bounded && !signal.aborted && inconclusiveAssessments > 0 && route.executionConfig.runtimeMode === "agent" && inspectedActualState
      && Array.isArray(latestExecution.mutationEvents) && Array.isArray(latestExecution.toolEvidence)
      && resolved.every(item => item.state !== "externally_resolved")) {
      for (const { run, event, state } of resolved) {
        event.verification = state;
        this.memory.update_run(run.id, { metadata: run.metadata });
      }
      return { verdict: "retry", safeToRetry: true,
        summary: "Verification could not establish acceptance; inspect actual state and repair locally within the remaining attempt budget.",
        evidence: verificationErrors };
    }
    if (!signal.aborted) this.block(route, step, bounded ? "verification_unknown" : "verification_exhausted", bounded ? "Bounded read-only verification returned unknown or exceeded its budget; acceptance was not established." : "The configured model could not produce a verifiable assessment after three read-only checks.", verificationErrors,
      "Choose an explicit permitted verifier configuration or provide the missing evidence. Fixed routing cannot change without an external decision.",
      ["Select a permitted model through continue_route.verificationConfig.executionConfig", "Provide independently verified evidence", "Retry the current model with an explicit resolution"]);
    return null;
  }

  private async execute(route: WorkingRoute, step: RouteStep, signal: AbortSignal, phase: "execution" | "verification", instruction: string,
    verification?: Parameters<SupervisorBridge["supervisorExecuteStep"]>[0]["verification"], executionKind?: "action" | "repair", repairAttempt?: RepairAttempt): Promise<SupervisorStepResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const configured = Number(process.env.JABBERWOCK_SUPERVISOR_TIMEOUT_MS);
    const timeoutMs = phase === "verification" ? Math.min(route.verificationConfig?.timeoutMs ?? 90_000, 180_000)
      : configured > 0 && Number.isFinite(configured) ? Math.min(configured, 3_600_000) : 600_000;
    const timer = setTimeout(() => controller.abort(new Error(`Supervisor step timed out after ${timeoutMs} ms.`)), timeoutMs);
    timer.unref();
    try {
      return await this.bridge.supervisorExecuteStep({ ...route.executionConfig, ...(phase === "verification" ? route.verificationConfig?.executionConfig : {}), taskId: route.taskId, stepId: step.id,
        routeId: route.id, phase, instruction, verification, executionKind, repairAttempt,
        expectedOutput: repairAttempt ? `Resolve only target ${repairAttempt.repairTarget.id}; return actual correction evidence.` : step.acceptanceCriteria.join("\n"), signal: controller.signal,
        ...(phase === "verification" ? { permissions: "read_only" as const, toolProtocol: "json" as const } : {}) });
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }

  private attemptEvidence(step: RouteStep, bounded = false): string {
    const runs = this.memory.list_runs_for_step(step.id);
    return JSON.stringify((bounded ? runs.filter(run => record(run.metadata.runtime).phase !== "verification").slice(-1) : runs.slice(-6)).map(run => {
      const runtime = record(run.metadata.runtime);
      return { status: run.status, phase: runtime.phase, response: run.response.slice(0, 1_000),
        mutationEvents: runtime.mutationEvents,
        toolEvidence: Array.isArray(runtime.toolEvidence) ? runtime.toolEvidence.slice(-12).map(value => {
          const tool = record(value);
          return { name: tool.name, path: tool.path, success: tool.success, exitCode: tool.exitCode, error: tool.error,
            ...(tool.name === "shell.exec" ? { output: String(tool.output ?? "").slice(-1_500) } : {}) };
        }) : [], commandSummaries: runtime.commandSummaries };
    })).slice(0, bounded ? 4_000 : 8_000);
  }
  private lastRejection(step: RouteStep): { runId: string; counterevidence: string[]; workspaceRepairable: boolean; repairTargets: RepairTarget[] } | null {
    const run = this.memory.list_runs_for_step(step.id).filter(run => record(run.metadata.runtime).phase === "verification").at(-1);
    if (!run || run.status !== "completed") return null;
    try {
      const assessment = assessmentSchema.safeParse(JSON.parse(step.assessment ?? "null"));
      if (!assessment.success || assessment.data.verdict !== "retry" || !assessment.data.safeToRetry || externalBlockCodes.has(assessment.data.code ?? "")) return null;
      const result = record(JSON.parse(run.response));
      const counterevidence = assessment.data.counterevidence ?? result.counterevidence;
      if (!Array.isArray(counterevidence) || !counterevidence.length || counterevidence.some(value => typeof value !== "string" || !value.trim())) return null;
      return { runId: run.id, counterevidence: counterevidence.slice(0, 20).map(value => value.slice(0, 2_000)),
        workspaceRepairable: assessment.data.workspaceRepairable ?? result.verdict === "retry", repairTargets: assessment.data.repairTargets ?? [] };
    } catch { return null; }
  }
  private canRepair(route: WorkingRoute, step: RouteStep, evidence: string[], workspaceRepairable: boolean): boolean {
    if (!route.executionConfig.correctiveExecution?.stepIndexes.includes(step.index)) {
      this.block(route, step, "remediation_not_allowed", "This observational step is not authorized for workspace remediation.", evidence,
        "Authorize remediation for this step or correct the workspace through its action step."); return false;
    }
    if (route.executionConfig.permissions !== "read_write") {
      this.block(route, step, "repair_requires_read_write", "Workspace remediation requires explicit read_write execution permissions.", evidence,
        "Supply an authorized action-step recovery or permitted read_write remediation configuration."); return false;
    }
    if (!evidence.length || !workspaceRepairable) {
      this.block(route, step, "repair_scope_unknown", "Verification did not establish a safe workspace repair.", evidence,
        "Resolve the external failure or provide a scoped action step; inspection failure alone does not authorize an edit."); return false;
    }
    return true;
  }
  private prepareRepair(route: WorkingRoute, step: RouteStep, rejection: { runId: string; repairTargets: RepairTarget[] }): RepairAttempt | undefined {
    const target = selectRepairTarget(rejection.repairTargets);
    if (!target) {
      this.block(route, step, "repair_scope_unknown", "Remaining counterevidence has no auto-repairable semantic source target.", rejection.repairTargets.map(target => target.failure),
        "Provide a verification policy that anchors the remaining evidence to the required behavior; isolated literal insertion is not authorized."); return;
    }
    const runs = this.memory.list_runs_for_step(step.id).filter(run => record(record(run.metadata.runtime).repairTarget).id === target.id);
    const history = runs.map(run => record(run.metadata.runtime));
    const resolved = history.some(meta => meta.targetResolved === true);
    const stalled = history.length >= 2 && history.slice(-2).every(meta => meta.targetResolved === false);
    if (resolved || stalled) {
      this.block(route, step, resolved ? "repair_target_regressed" : "repair_target_stalled",
        resolved ? `Previously resolved target ${target.id} failed again.` : `Target ${target.id} remains unresolved after two local attempts.`,
        [target.failure], "", undefined, { repairTarget: target, targetAttempts: runs.length, model: runs.at(-1)?.model ?? route.executionConfig.model,
          toolsUsed: [...new Set(history.flatMap(meta => Array.isArray(meta.toolsUsed) ? meta.toolsUsed.map(String) : []))] }); return;
    }
    return { repairTarget: target, verificationRunId: rejection.runId, failedCriterion: target.criterionReference, targetAttemptNumber: runs.length + 1 };
  }
  private recordRepairResult(step: RouteStep, assessment: Assessment | null): void {
    const runs = this.memory.list_runs_for_step(step.id);
    const repair = runs.filter(run => record(run.metadata.runtime).executionKind === "repair").at(-1);
    if (!repair) return;
    const meta = record(repair.metadata.runtime);
    if (meta.resultVerificationRunId) return;
    const target = repairTargetSchema.safeParse(meta.repairTarget);
    if (!target.success) return;
    const verification = runs.filter(run => record(run.metadata.runtime).phase === "verification").at(-1);
    if (!verification || runs.indexOf(verification) < runs.indexOf(repair)) return;
    const inspection = record(record(verification.metadata.runtime).workspaceInspection);
    const inspectedTargets = z.array(repairTargetSchema).safeParse(inspection.repairTargets);
    const remaining = inspectedTargets.success ? inspectedTargets.data.find(value => value.id === target.data.id) : undefined;
    // Source resolution is established only by actual policy inspection, even if the full verdict has an external blocker.
    const known = inspectedTargets.success;
    const targetResolved = known && !remaining;
    this.memory.update_run(repair.id, { metadata: { ...repair.metadata, runtime: { ...meta, resultVerificationRunId: verification.id,
      targetResolved, targetFailureAfter: remaining?.failure ?? (known ? null : assessment?.summary ?? this.requireRoute(step.routeId).blockedReason?.blockedReason),
      noProgress: known ? !targetMadeProgress(target.data, remaining) : null, verificationOutcome: assessment?.verdict ?? "unknown" } } });
  }
  private repairInstruction(route: WorkingRoute, step: RouteStep, attempt: RepairAttempt): string {
    const state = this.bridge.supervisorGetState(route.taskId);
    const decision = step.recoveryResolution ?? state.decisions.filter(value => value.rationale.includes(`Route ${route.id}:`)).at(-1)?.text;
    return ["CORRECTIVE EXECUTION", "Repair exactly ONE target in this execution. The original full step is independently verified after this attempt.",
      `Original step context (not additional repair tasks): ${step.instruction}`, `Original acceptance context: ${JSON.stringify(step.acceptanceCriteria)}`,
      `repairTarget: ${JSON.stringify(attempt.repairTarget)}`, `verificationRunId: ${attempt.verificationRunId}`,
      `failedCriterion: ${attempt.failedCriterion}`, `targetAttemptNumber: ${attempt.targetAttemptNumber}`,
      `scope: Existing route step ${step.index}; workspace ${state.project.rootPath}; permissions ${route.executionConfig.permissions}. Preserve unrelated work and completed steps.`,
      `constraints: ${JSON.stringify(route.executionConfig.constraints ?? [])}`,
      "action: Modify the workspace to resolve ONLY this repairTarget as part of the original criterion's implementation. expectedCondition is the exact machine-readable resolution predicate; actualEvidence records the current inspected state. supportingFailures only explain this one semantic postcondition, not separate token-insertion tasks. Do not add dead/unrelated code, dummy constants, or isolated literals to game the predicate. Read the target source, make the smallest functional correction, inspect the result and return evidence. Preserve the existing helper and completed work. Changes beyond this target are allowed only if strictly necessary for its correction. Do not merely re-verify, duplicate resolved work or run build/test unless the selected target is a process_receipt. The read-only verifier checks ALL original criteria again; target resolution alone does not accept the step.",
      `Recovery decision: ${decision ?? "none"}`].join("\n");
  }
  private exhausted(route: WorkingRoute, step: RouteStep, evidence: string[] = []): void {
    this.block(route, step, "max_attempts", `Step exhausted ${step.attempts} attempts.`, evidence, "Resolve the repeated failure to grant another bounded attempt budget.");
  }
  private block(route: WorkingRoute, step: RouteStep | undefined, code: string, reason: string, evidence: string[], question: string, possibleOptions?: string[], targetDetails?: Pick<RouteBlock, "repairTarget" | "targetAttempts" | "model" | "toolsUsed">): void {
    if (this.requireRoute(route.id).status !== "running") return;
    const blockedReason: RouteBlock = { code, blockedReason: reason, failedStep: step?.id ?? null, attempts: step?.attempts ?? 0, evidence, question, ...(possibleOptions ? { possibleOptions } : {}), ...targetDetails };
    blockedReason.kind = codingBlockCodes.has(code) ? "coding_escalation" : externalBlockCodes.has(code) ? "external_decision" : "verification";
    if (step && blockedReason.kind === "coding_escalation") {
      blockedReason.question ||= "Apply an external coding fix and submit evidence through continue_route.externalResolution.";
      blockedReason.escalation = this.escalationPacket(route, step, blockedReason);
    }
    if (step) this.memory.update_route_step(step.id, { status: "blocked", error: reason });
    this.memory.update_route(route.id, { status: "blocked", blockedReason, summary: reason }); this.publish(route.id);
  }
  private escalationPacket(route: WorkingRoute, step: RouteStep, block: RouteBlock): CodingEscalationPacket {
    const context = this.memory.get_task_context(route.taskId)!;
    const runs = this.memory.list_runs_for_step(step.id);
    const targetRuns = runs.filter(run => {
      const meta = record(run.metadata.runtime);
      return meta.phase !== "verification" && meta.executionKind !== "external_resolution"
        && (!block.repairTarget || record(meta.repairTarget).id === block.repairTarget.id);
    });
    const policy = route.verificationConfig?.policies?.find(value => value.stepIndex === step.index) ?? null;
    const changedFiles = [...new Set(route.steps.flatMap(value => this.memory.list_runs_for_step(value.id)).flatMap(run => {
      const meta = record(run.metadata.runtime);
      return [...mutations(meta).filter(event => event.state === "finished" && event.success).map(event => event.path).filter((path): path is string => Boolean(path)),
        ...(meta.externalVerification === "accepted" && Array.isArray(meta.changedFiles) ? meta.changedFiles.map(String) : [])];
    }))];
    return { routeId: route.id, taskId: route.taskId, stepId: step.id, instruction: step.instruction,
      originalGoal: context.task_goal.original_request, acceptanceCriteria: step.acceptanceCriteria, reason: block.blockedReason,
      repairTarget: block.repairTarget, expectedCondition: block.repairTarget?.expectedCondition, counterevidence: block.evidence,
      relevantSourcePaths: [...new Set([...(block.repairTarget?.path ? [block.repairTarget.path] : []), ...(policy?.sources?.map(value => value.path) ?? [])])],
      changedFiles, model: block.model ?? route.executionConfig.model, protocol: route.executionConfig.toolProtocol ?? "auto",
      localAttempts: targetRuns.map(run => { const meta = record(run.metadata.runtime); return { runId: run.id, model: run.model, status: run.status,
        summary: run.response.slice(0, 1_000), tools: meta.toolsUsed ?? [], results: Array.isArray(meta.toolEvidence) ? meta.toolEvidence.slice(-12).map(value => { const tool = record(value); return { name: tool.name, path: tool.path, success: tool.success, exitCode: tool.exitCode, error: tool.error }; }) : [],
        targetResolved: meta.targetResolved ?? null, noProgress: meta.noProgress ?? null }; }),
      relevantDecisions: context.decisions.slice(-5).map(value => ({ id: value.id, text: value.text, rationale: value.rationale })),
      recommendedVerification: { instruction: step.instruction, acceptanceCriteria: step.acceptanceCriteria, policy } };
  }
  private requireRoute(routeId: string): WorkingRoute {
    const route = this.memory.get_route(routeId);
    if (!route) throw new RouteRunnerError("ROUTE_NOT_FOUND", "Route was not found.");
    return route;
  }
  private publish(routeId: string): void { this.events.emit("state", this.get_route_state(routeId)); }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function mutations(meta: Record<string, unknown>): MutationEvent[] { return Array.isArray(meta.mutationEvents) ? meta.mutationEvents as MutationEvent[] : []; }
function hasInspection(meta: Record<string, unknown>): boolean {
  if (Array.isArray(meta.toolEvidence)) return meta.toolEvidence.some(value => { const evidence = record(value); return evidence.success === true && ["fs.read", "fs.search", "git.diff", "fs.inspect", "command.receipt"].includes(String(evidence.name)); });
  return Array.isArray(meta.toolsUsed) && meta.toolsUsed.some(tool => ["fs.read", "fs.search", "git.diff"].includes(String(tool)));
}
function compactStep(step: RouteStep) { return { id: step.id, index: step.index, title: step.title, status: step.status,
  attempts: step.attempts, maxAttempts: step.maxAttempts, summary: step.result_summary, error: step.error }; }
function now(): string { return new Date().toISOString(); }
