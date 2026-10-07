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
const verdict = (response: string): string | undefined => { try { return JSON.parse(response).verdict; } catch { return undefined; } };
const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
const mode = process.argv[2] ?? "--controlled";
if (mode === "--controlled") {
  const root = await mkdtemp(join(tmpdir(), "jabberwock-semantic-control-"));
  const baseline = 'export function setActive(active: boolean) { return active; }\nexport const events = new EventTarget();\n';
  await writeFile(join(root, "probe.ts"), baseline);
  const memory = new JabberwockMemoryService(":memory:");
  // Disposable control only: all its acceptance clauses are represented by source AST policies.
  // Real Qwen executor and real source inspections; no simulated tools or model-generated edits.
  const runner = new RouteRunner(memory, new SupervisorBridge(memory, { verificationRuntime: { execute: async input => {
    if (!input.verification?.toolEvidence.length) throw new Error("Controlled scenario requires actual deterministic source evidence.");
    return { response: JSON.stringify({ verdict: input.verification.counterevidence.length ? "rejected" : "accepted", reason: "Actual disposable source AST policy",
      evidence: input.verification.evidence, counterevidence: input.verification.counterevidence }),
      metadata: { boundedVerifier: true, runtimeMode: "verifier", permissions: "read_only", modelCalls: 0,
        toolsUsed: ["fs.inspect"], toolEvidence: input.verification.toolEvidence } };
  } } }));
  const project = memory.create_project({ name: "Disposable semantic control", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Verify event wiring", original_request: "A helper exists but event wiring may be missing. Verify, repair failures within this workspace, and independently re-verify." });
  const policy = { stepIndex: 1, sources: [{ path: "probe.ts", uniqueSymbol: "setActive", requiredCalls: ["setActive", "events.addEventListener"], requiredLiterals: ["status"] }] };
  const route = runner.create_route({ taskId: task.id, autoStart: false,
    executionConfig: { routingMode: "fixed", model: "qwen3:8b", runtimeMode: "agent", permissions: "read_write", maxToolTurns: 16, toolProtocol: "native", correctiveExecution: { stepIndexes: [1] } },
    verificationConfig: { timeoutMs: 90_000, executionConfig: { routingMode: "fixed", model: "bonsai-2-27b" }, policies: [{ stepIndex: 0, sources: [{ path: "probe.ts", uniqueSymbol: "setActive" }] }, policy] },
    steps: [{ title: "Existing implementation", instruction: "Read probe.ts and confirm setActive already exists. Preserve the implementation in this item; wiring is handled by the next item.", acceptanceCriteria: ["Exactly one setActive helper implementation exists in probe.ts."] },
      { title: "Verify lifecycle wiring", instruction: "Verify lifecycle wiring in probe.ts. The initial execution should inspect and report current state; a rejected verification is handled by a separate corrective execution.",
        acceptanceCriteria: ["Exactly one setActive helper exists, events.addEventListener registers a status event listener, and that listener actually calls setActive(true)."], maxAttempts: 3 }] });
  const start = Date.now(); runner.events.on("state", state => console.info(JSON.stringify({ status: state.status, completed: state.completedSteps, step: state.currentStep, block: state.blockedReason })));
  runner.start_route(route.id); await runner.wait(route.id);
  const finalRoute = memory.get_route(route.id)!; const runs = finalRoute.steps.flatMap(step => memory.list_runs_for_step(step.id));
  const actual = await readFile(join(root, "probe.ts"), "utf8");
  const inspection = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), policy, []);
  const rejected = runs.findIndex(run => (run.metadata.runtime as any)?.phase === "verification" && verdict(run.response) === "rejected");
  const repair = runs.findIndex(run => (run.metadata.runtime as any)?.executionKind === "repair");
  const repairRuns = runs.filter(run => (run.metadata.runtime as any)?.executionKind === "repair");
  const mutations = repairRuns.flatMap(run => ((run.metadata.runtime as any)?.mutationEvents ?? []).filter((event: any) => event.state === "finished" && event.success));
  const acceptedAfter = repair >= 0 && runs.slice(repair + 1).some(run => (run.metadata.runtime as any)?.phase === "verification" && verdict(run.response) === "accepted");
  const passed = finalRoute.status === "completed" && rejected >= 0 && repair > rejected && mutations.length > 0 && actual !== baseline
    && inspection.counterevidence.length === 0 && acceptedAfter && repairRuns.every(run => run.prompt.includes("Modify the workspace") && run.prompt.includes("counterevidence:"));
  await writeFile(join(output, "controlled-semantic-scenario.json"), JSON.stringify({ passed, model: "qwen3:8b", toolProtocol: "native", verifier: "deterministic_source_policy_control_only", verifierModelInference: false, root, durationMs: Date.now() - start,
    baseline, actual, beforeHash: hash(baseline), afterHash: hash(actual), inspection, rejectedRunIndex: rejected, repairRunIndex: repair, acceptedAfter, mutationCount: mutations.length,
    route: finalRoute, state: runner.get_route_state(route.id), runs, externalAcceptanceExecuteSteps: 0, persistedAcceptanceRoutesCreated: 0 }, null, 2));
  console.info(JSON.stringify({ passed, status: finalRoute.status, rejected, repair, mutationCount: mutations.length, durationMs: Date.now() - start }));
  await runner.close(); memory.close();
} else if (mode === "--continue") {
  const smoke = JSON.parse(await readFile(join(output, "controlled-semantic-scenario.json"), "utf8"));
  if (!smoke.passed || smoke.model !== "qwen3:8b" || smoke.toolProtocol !== "native") throw new Error("Controlled verify/repair/verify PASS required; no acceptance attempt.");
  const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
  const runner = new RouteRunner(memory, new SupervisorBridge(memory)); const before = memory.get_route(routeId)!;
  if (before.status !== "blocked" || before.steps[6].attempts !== 14) throw new Error("Exactly one continuation from original attempt 14 is allowed.");
  if (before.executionConfig.model !== "qwen3:8b" || before.executionConfig.toolProtocol !== "native" || before.executionConfig.maxToolTurns !== 16) throw new Error("Original executor configuration required.");
  const previousRunIds = before.steps.flatMap(step => memory.list_runs_for_step(step.id).map(run => run.id));
  const backgroundPath = "I:/PersonaCore/extension/src/background/index.ts"; const backgroundBefore = await readFile(backgroundPath, "utf8");
  runner.events.on("state", state => console.info(JSON.stringify({ status: state.status, completed: state.completedSteps, step: state.currentStep, block: state.blockedReason })));
  runner.continue_route({ routeId, resolution: "User approved one bounded continuation after corrective-execution semantics fix. Controlled Qwen/native verification-rejection -> explicit workspace repair -> independent re-verification PASS. Authorize bounded remediation for the remaining steps under existing Step IDs. Preserve all prior attempts, Runs, Decisions, assessments, evidence and completed Steps; retain fixed Qwen/native/16-turn executor and original bounded read-only fixed Bonsai verifier/policies/timeouts. Persona Bridge OFF; no cloud fallback, manual Persona edits or external acceptance execute_step.",
    executionConfig: { ...before.executionConfig, correctiveExecution: { stepIndexes: [6, 7, 8, 9] } } });
  await runner.wait(routeId);
  const after = memory.get_route(routeId)!; const runs = after.steps.flatMap(step => memory.list_runs_for_step(step.id)); const newRuns = runs.filter(run => !previousRunIds.includes(run.id));
  await writeFile(join(output, "corrective-acceptance-continuation.json"), JSON.stringify({ before, after, state: runner.get_route_state(routeId), previousRunIds, newRuns,
    oldRunIdsPreserved: previousRunIds.every(id => runs.some(run => run.id === id)), verifierConfigUnchanged: JSON.stringify(before.verificationConfig) === JSON.stringify(after.verificationConfig),
    backgroundHashBefore: hash(backgroundBefore), backgroundHashAfter: hash(await readFile(backgroundPath, "utf8")), manualPersonaCoreEdits: 0, externalAcceptanceExecuteSteps: 0, newAcceptanceRoutes: 0 }, null, 2));
  console.info(JSON.stringify({ status: after.status, completed: runner.get_route_state(routeId).completedSteps, attempts: after.steps[6].attempts, newRuns: newRuns.length }));
  await runner.close(); memory.close();
} else throw new Error("Use --controlled or --continue.");
