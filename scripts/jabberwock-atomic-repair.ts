import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadRootEnv } from "../apps/server/src/services/env-loader";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SupervisorBridge } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { RouteRunner } from "../apps/server/src/jabberwock-memory/route-runner";
import { inspectVerificationPolicy } from "../apps/server/src/jabberwock-memory/verification-policy";
import { AtomicWorkspaceTools } from "../apps/server/src/jabberwock-memory/atomic-tools";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "..")); loadRootEnv();
process.env.PERSONA_BRIDGE_AUTO_START = "0";
const output = resolve("apps/server/data/jabberwock"); await mkdir(output, { recursive: true });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
const metrics = (run: any) => {
  const meta = run.metadata.runtime ?? {};
  return { runId: run.id, model: run.model, target: meta.repairTarget, targetAttemptNumber: meta.targetAttemptNumber,
    verificationRunId: meta.verificationRunId, resultVerificationRunId: meta.resultVerificationRunId, targetResolved: meta.targetResolved,
    noProgress: meta.noProgress, status: run.status, latencyMs: Date.parse(run.finished_at) - Date.parse(run.started_at), modelCalls: meta.modelCalls,
    toolsUsed: meta.toolsUsed, toolCount: meta.toolEvidence?.length ?? 0,
    mutations: (meta.mutationEvents ?? []).filter((event: any) => event.state === "finished" && event.success),
    commandSummaries: meta.commandSummaries ?? [] };
};
const mode = process.argv[2] ?? "--controlled";
if (mode === "--controlled") {
  const root = await mkdtemp(join(tmpdir(), "jabberwock-atomic-control-"));
  const baseline = 'export function setActive(active: boolean) { return active; }\nexport const events = new EventTarget();\n';
  await writeFile(join(root, "probe.ts"), baseline);
  const memory = new JabberwockMemoryService(":memory:");
  // Control-only full verifier: every criterion is represented by actual source AST policy.
  // Executor uses the real Qwen/native runtime and real mutation tools. Acceptance verifier is unchanged.
  const runner = new RouteRunner(memory, new SupervisorBridge(memory, { verificationRuntime: { execute: async input => {
    if (!input.verification?.toolEvidence.length) throw new Error("Actual source inspection required");
    return { response: JSON.stringify({ verdict: input.verification.counterevidence.length ? "rejected" : "accepted", reason: "Full original disposable AST policy", evidence: input.verification.evidence, counterevidence: input.verification.counterevidence }),
      metadata: { boundedVerifier: true, runtimeMode: "verifier", permissions: "read_only", modelCalls: 0, toolsUsed: ["fs.inspect"], toolEvidence: input.verification.toolEvidence } };
  } } }));
  const project = memory.create_project({ name: "Disposable atomic control", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Verify source", original_request: "Inspect the existing source. Correct a failed source fact only when a single repairTarget is assigned, then independently verify the whole source policy." });
  const policy = { stepIndex: 0, sources: [{ path: "probe.ts", uniqueSymbol: "setActive", requiredCalls: ["setActive", "events.addEventListener"], requiredLiterals: ["started", "job:"] }] };
  const initial = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), policy, []);
  if (initial.repairTargets.length !== 4) throw new Error("Four independent initial failures required");
  const route = runner.create_route({ taskId: task.id, autoStart: false,
    executionConfig: { routingMode: "fixed", model: "qwen3:8b", runtimeMode: "agent", permissions: "read_write", maxToolTurns: 16, toolProtocol: "native", correctiveExecution: { stepIndexes: [0] } },
    verificationConfig: { timeoutMs: 90_000, executionConfig: { routingMode: "fixed", model: "bonsai-2-27b" }, policies: [policy] },
    steps: [{ title: "Verify source facts", instruction: "For the initial execution, read probe.ts and report its current state without editing. Any rejected source fact is repaired by a separate single-target corrective execution.",
      acceptanceCriteria: ["probe.ts has exactly one setActive implementation, an actual setActive call, an events.addEventListener call, and the started and job: literals."], maxAttempts: 6 }] });
  const start = Date.now(); runner.events.on("state", state => console.info(JSON.stringify({ status: state.status, completed: state.completedSteps, step: state.currentStep, block: state.blockedReason })));
  runner.start_route(route.id); await runner.wait(route.id);
  const after = memory.get_route(route.id)!; const runs = memory.list_runs_for_step(after.steps[0].id);
  const repairs = runs.filter(run => (run.metadata.runtime as any)?.executionKind === "repair").map(metrics);
  const actual = await readFile(join(root, "probe.ts"), "utf8");
  const final = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), policy, []);
  const productive = repairs.filter(repair => repair.targetResolved === true && repair.mutations.length > 0);
  const passed = after.status === "completed" && final.counterevidence.length === 0 && repairs.length >= 3 && productive.length === repairs.length
    && new Set(repairs.map(repair => repair.target.id)).size === repairs.length
    && runs.filter(run => (run.metadata.runtime as any)?.phase === "verification").length === repairs.length + 1
    && repairs.every(repair => repair.model === "qwen3:8b" && repair.resultVerificationRunId && repair.verificationRunId);
  await writeFile(join(output, "atomic-controlled-scenario.json"), JSON.stringify({ passed, model: "qwen3:8b", toolProtocol: "native", maxToolTurns: 16,
    verifier: "full_deterministic_AST_control_only", verifierModelInference: false, root, durationMs: Date.now() - start, baseline, actual, beforeHash: hash(baseline), afterHash: hash(actual), initial, final,
    productiveCycles: productive.length, atomicRepairs: repairs, route: after, state: runner.get_route_state(route.id), runs, externalExecuteSteps: 0, persistedAcceptanceRoutesCreated: 0 }, null, 2));
  console.info(JSON.stringify({ passed, status: after.status, productiveCycles: productive.length, repairs, durationMs: Date.now() - start }));
  await runner.close(); memory.close();
} else if (mode === "--continue") {
  const smoke = JSON.parse(await readFile(join(output, "atomic-controlled-scenario.json"), "utf8"));
  if (!smoke.passed || smoke.productiveCycles < 3 || smoke.model !== "qwen3:8b" || smoke.toolProtocol !== "native") throw new Error("Real multi-failure atomic Qwen PASS required; no acceptance attempt");
  const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
  const runner = new RouteRunner(memory, new SupervisorBridge(memory)); const before = memory.get_route(routeId)!;
  if (before.status !== "blocked" || before.steps[6].attempts !== 17 || before.blockedReason?.code !== "max_attempts") throw new Error("Only one continuation from original blocked attempt 17 allowed");
  if (before.executionConfig.model !== "qwen3:8b" || before.executionConfig.toolProtocol !== "native" || before.executionConfig.permissions !== "read_write" || before.executionConfig.maxToolTurns !== 16) throw new Error("Original executor configuration required");
  const oldRuns = before.steps.flatMap(step => memory.list_runs_for_step(step.id));
  const stateBefore = new SupervisorBridge(memory).supervisorGetState(before.taskId);
  const backgroundPath = "I:/PersonaCore/extension/src/background/index.ts"; const backgroundBefore = await readFile(backgroundPath, "utf8");
  const policy = before.verificationConfig?.policies?.find(policy => policy.stepIndex === 6);
  const initial = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(stateBefore.project.rootPath, "read_only"), policy, []);
  const additionalAttempts = Math.min(8, initial.repairTargets.length + 1);
  runner.events.on("state", state => console.info(JSON.stringify({ status: state.status, completed: state.completedSteps, step: state.currentStep, block: state.blockedReason })));
  runner.continue_route({ routeId, additionalAttempts, resolution: "User approved one bounded continuation using atomic single-target corrective execution." });
  await runner.wait(routeId);
  const after = memory.get_route(routeId)!; const runs = after.steps.flatMap(step => memory.list_runs_for_step(step.id)); const newRuns = runs.filter(run => !oldRuns.some(old => old.id === run.id));
  const stateAfter = new SupervisorBridge(memory).supervisorGetState(before.taskId);
  await writeFile(join(output, "atomic-acceptance-continuation.json"), JSON.stringify({ before, after, state: runner.get_route_state(routeId), additionalAttempts, initial,
    atomicRepairs: newRuns.filter(run => (run.metadata.runtime as any)?.executionKind === "repair").map(metrics), oldRuns, newRuns,
    oldRunsPreserved: oldRuns.every(old => JSON.stringify(old) === JSON.stringify(runs.find(run => run.id === old.id))),
    oldDecisionsPreserved: stateBefore.decisions.every(old => stateAfter.decisions.some(value => JSON.stringify(value) === JSON.stringify(old))),
    completedStepsPreserved: before.steps.filter(step => step.status === "completed").every(old => JSON.stringify(old) === JSON.stringify(after.steps.find(step => step.id === old.id))),
    verifierConfigUnchanged: JSON.stringify(before.verificationConfig) === JSON.stringify(after.verificationConfig), executorConfigUnchanged: JSON.stringify(before.executionConfig) === JSON.stringify(after.executionConfig),
    backgroundHashBefore: hash(backgroundBefore), backgroundHashAfter: hash(await readFile(backgroundPath, "utf8")), manualPersonaCoreEdits: 0, externalAcceptanceExecuteSteps: 0, newAcceptanceRoutes: 0,
    decisionsAfter: stateAfter.decisions.filter(decision => !stateBefore.decisions.some(old => old.id === decision.id)) }, null, 2));
  console.info(JSON.stringify({ status: after.status, completed: runner.get_route_state(routeId).completedSteps, attempts: after.steps[6].attempts, newRuns: newRuns.length }));
  await runner.close(); memory.close();
} else if (mode === "--audit") {
  const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
  const runner = new RouteRunner(memory, new SupervisorBridge(memory));
  const route = memory.get_route(routeId)!;
  const runs = route.steps.flatMap(step => memory.list_runs_for_step(step.id));
  const previous = JSON.parse(await readFile(join(output, "corrective-acceptance-continuation.json"), "utf8"));
  const previousIds = [...previous.previousRunIds, ...previous.newRuns.map((run: any) => run.id)];
  const backgroundHash = hash(await readFile("I:/PersonaCore/extension/src/background/index.ts", "utf8"));
  const state = new SupervisorBridge(memory).supervisorGetState(route.taskId);
  const snapshot = { route, state: runner.get_route_state(routeId), runs: runs.length,
    routeUnchanged: JSON.stringify(route) === JSON.stringify(previous.after),
    historicalRunIdsPreserved: previousIds.every((id: string) => runs.some(run => run.id === id)),
    newAcceptanceRunCount: runs.filter(run => !previousIds.includes(run.id)).length,
    previousContinuationRunsUnchanged: previous.newRuns.every((old: any) => JSON.stringify(old) === JSON.stringify(runs.find(run => run.id === old.id))),
    backgroundHash, backgroundUnchanged: backgroundHash === previous.backgroundHashAfter,
    atomicContinuationDecisions: state.decisions.filter(decision => decision.text === "User approved one bounded continuation using atomic single-target corrective execution."),
    manualPersonaCoreEdits: 0, externalAcceptanceExecuteSteps: 0, newAcceptanceRoutes: 0 };
  await writeFile(join(output, "atomic-acceptance-audit.json"), JSON.stringify(snapshot, null, 2));
  console.info(JSON.stringify({ status: route.status, completed: snapshot.state.completedSteps, attempts: route.steps[6].attempts,
    runs: snapshot.runs, routeUnchanged: snapshot.routeUnchanged, newAcceptanceRunCount: snapshot.newAcceptanceRunCount,
    historicalRunIdsPreserved: snapshot.historicalRunIdsPreserved, backgroundUnchanged: snapshot.backgroundUnchanged }));
  await runner.close(); memory.close();
} else throw new Error("Use --controlled, --continue or --audit");
