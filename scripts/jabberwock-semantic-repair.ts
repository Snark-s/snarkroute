import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadRootEnv } from "../apps/server/src/services/env-loader";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SupervisorBridge } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { RouteRunner } from "../apps/server/src/jabberwock-memory/route-runner";
import { inspectVerificationPolicy, type VerificationPolicy } from "../apps/server/src/jabberwock-memory/verification-policy";
import { AtomicWorkspaceTools } from "../apps/server/src/jabberwock-memory/atomic-tools";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "..")); loadRootEnv();
process.env.PERSONA_BRIDGE_AUTO_START = "0";
const output = resolve("apps/server/data/jabberwock"); await mkdir(output, { recursive: true });
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
const resolution = "User approved one bounded continuation after semantic repair-target contract passed the real local Qwen gate.";
const mutations = (run: any) => (run.metadata.runtime?.mutationEvents ?? []).filter((event: any) => event.state === "finished" && event.success);
const metrics = (run: any) => ({ runId: run.id, model: run.model, status: run.status, target: run.metadata.runtime?.repairTarget,
  targetAttemptNumber: run.metadata.runtime?.targetAttemptNumber, targetResolved: run.metadata.runtime?.targetResolved,
  resultVerificationRunId: run.metadata.runtime?.resultVerificationRunId, noProgress: run.metadata.runtime?.noProgress,
  durationMs: Date.parse(run.finished_at) - Date.parse(run.started_at), modelCalls: run.metadata.runtime?.modelCalls,
  toolsUsed: run.metadata.runtime?.toolsUsed, toolCount: run.metadata.runtime?.toolEvidence?.length ?? 0, mutations: mutations(run),
  commandSummaries: run.metadata.runtime?.commandSummaries ?? [], primaryTargetCount: (run.prompt.match(/^repairTarget: /gm) ?? []).length });
const mode = process.argv[2] ?? "--controlled";
if (mode === "--controlled") {
  const root = await mkdtemp(join(tmpdir(), "jabberwock-semantic-gate-"));
  const baseline: Record<string, string> = {
    "call.ts": 'export let active = false;\nexport function setActive(value: boolean) { active = value; }\n',
    "event.ts": 'export const events = new EventTarget();\nexport let started = 0;\nexport function onStarted() { started += 1; }\nevents.addEventListener("wrong-event", onStarted);\n',
    "callback.ts": 'export const events = new EventTarget();\nexport let active = false;\nexport function setActive(value: boolean) { active = value; }\nevents.addEventListener("started", () => { setActive(false); });\n'
  };
  for (const [path, source] of Object.entries(baseline)) await writeFile(join(root, path), source);
  const policy: VerificationPolicy = { stepIndex: 0, sources: [
    { path: "call.ts", uniqueSymbol: "setActive", requiredCalls: [{ callee: "setActive", topLevel: true, arguments: [{ index: 0, equals: true }] }] },
    { path: "event.ts", requiredCalls: [{ callee: "events.addEventListener", arguments: [{ index: 0, equals: "started" }] }] },
    { path: "callback.ts", uniqueSymbol: "setActive", requiredCalls: [{ callee: "setActive", arguments: [{ index: 0, equals: true }], within: { callee: "events.addEventListener", callbackArgument: 1, arguments: [{ index: 0, equals: "started" }] } }] }
  ] };
  const initial = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), policy, []);
  if (initial.repairTargets.filter(target => target.repairability === "auto").length !== 3) throw new Error("Three initial semantic targets required");
  const memory = new JabberwockMemoryService(":memory:");
  // Control-only verifier: every original control clause is represented by actual full-source AST predicates.
  // Real Qwen/native executor and actual workspace tools; no model-produced or manual repair simulation.
  const runner = new RouteRunner(memory, new SupervisorBridge(memory, { verificationRuntime: { execute: async input => {
    if (!input.verification?.toolEvidence.length) throw new Error("Actual full source inspection required");
    return { response: JSON.stringify({ verdict: input.verification.counterevidence.length ? "rejected" : "accepted", reason: "Full original semantic AST policy", evidence: input.verification.evidence, counterevidence: input.verification.counterevidence }),
      metadata: { boundedVerifier: true, runtimeMode: "verifier", permissions: "read_only", modelCalls: 0, toolsUsed: ["fs.inspect"], toolEvidence: input.verification.toolEvidence } };
  } } }));
  const project = memory.create_project({ name: "Disposable semantic target gate", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Verify lifecycle source", original_request: "Verify the existing lifecycle examples in call.ts, event.ts and callback.ts. Repair only the single assigned semantic target, using the existing implementation. Do not modify other files or add dummy code to satisfy predicates." });
  const route = runner.create_route({ taskId: task.id, autoStart: false,
    executionConfig: { routingMode: "fixed", model: "qwen3:8b", runtimeMode: "agent", permissions: "read_write", maxToolTurns: 16, toolProtocol: "native", correctiveExecution: { stepIndexes: [0] } },
    verificationConfig: { timeoutMs: 90_000, executionConfig: { routingMode: "fixed", model: "bonsai-2-27b" }, policies: [policy, { ...policy, stepIndex: 1 }] },
    steps: [{ title: "Verify semantic source", instruction: "Initial execution: read call.ts, event.ts and callback.ts and report current state without editing. A separate corrective execution handles each assigned semantic failure.",
      acceptanceCriteria: ["call.ts initializes active through setActive(true); event.ts registers onStarted for started; callback.ts activates the existing state through setActive(true) inside the started listener callback."], maxAttempts: 6 },
    { title: "Final source verification", instruction: "Read the final source files and report evidence. Preserve the source. Package-less workspace; no build/test is required.", acceptanceCriteria: ["The complete semantic source policy still passes. AST evidence does not claim runtime/build correctness."] }] });
  const start = Date.now(); runner.events.on("state", state => console.info(JSON.stringify({ status: state.status, completed: state.completedSteps, step: state.currentStep, block: state.blockedReason })));
  runner.start_route(route.id); await runner.wait(route.id);
  const after = memory.get_route(route.id)!; const runs = after.steps.flatMap(step => memory.list_runs_for_step(step.id));
  const repairs = runs.filter(run => run.metadata.runtime && (run.metadata.runtime as any).executionKind === "repair").map(metrics);
  const actual: Record<string, string> = {};
  for (const path of Object.keys(baseline)) actual[path] = await readFile(join(root, path), "utf8");
  const final = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), policy, []);
  const productive = repairs.filter(repair => repair.targetResolved === true && repair.mutations.some((event: any) => event.path === repair.target.path));
  const passed = after.status === "completed" && final.counterevidence.length === 0 && productive.length >= 3 && productive.length === repairs.length
    && new Set(repairs.map(repair => repair.target.id)).size === repairs.length && mutations(runs[0]).length === 0
    && repairs.every(repair => repair.primaryTargetCount === 1 && repair.model === "qwen3:8b" && repair.target.repairability === "auto" && repair.target.expectedCondition.type === "call_count" && repair.resultVerificationRunId);
  await writeFile(join(output, "semantic-controlled-scenario.json"), JSON.stringify({ passed, model: "qwen3:8b", toolProtocol: "native", maxToolTurns: 16,
    verifier: "full_semantic_AST_control_only", verifierModelInference: false, root, durationMs: Date.now() - start, baseline, actual, sourceHashes: Object.keys(baseline).map(path => ({ path, before: hash(baseline[path]), after: hash(actual[path]) })),
    initial, final, productiveCycles: productive.length, atomicRepairs: repairs, route: after, runs, manualRepairEdits: 0, externalExecuteSteps: 0, persistedAcceptanceRoutesCreated: 0 }, null, 2));
  console.info(JSON.stringify({ passed, status: after.status, productiveCycles: productive.length, repairs, durationMs: Date.now() - start }));
  await runner.close(); memory.close();
} else if (mode === "--review") {
  const gate = JSON.parse(await readFile(join(output, "semantic-controlled-scenario.json"), "utf8"));
  const policy: VerificationPolicy = structuredClone(gate.route.verificationConfig.policies[0]);
  // Keep initialization explicitly anchored to module scope, including historical candidate artifacts.
  const initialization = policy.sources![0].requiredCalls![0];
  if (typeof initialization === "string") throw new Error("Structured initialization predicate required");
  initialization.topLevel = true;
  const inspection = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(gate.root, "read_only"), policy, []);
  const productiveCycles = gate.atomicRepairs.filter((repair: any) => repair.targetResolved && repair.mutations.length
    && !inspection.repairTargets.some(target => target.path === repair.target.path && target.subject === repair.target.subject)).length;
  const passed = gate.passed && productiveCycles >= 3 && inspection.counterevidence.length === 0;
  await writeFile(join(output, "semantic-controlled-review.json"), JSON.stringify({ passed, candidateGatePassed: gate.passed, productiveCycles,
    reason: passed ? "Full original semantic source criteria confirmed" : "Full original semantic source criteria remain rejected; see actual counterevidence",
    policy, inspection, rawArtifactPreserved: true, modelReruns: 0, manualRepairEdits: 0, externalExecuteSteps: 0 }, null, 2));
  console.info(JSON.stringify({ passed, candidateGatePassed: gate.passed, productiveCycles, remaining: inspection.counterevidence }));
} else if (["--snapshot", "--audit", "--continue"].includes(mode)) {
  if (mode === "--continue") {
    const gate = JSON.parse(await readFile(join(output, "semantic-controlled-scenario.json"), "utf8"));
    const review = JSON.parse(await readFile(join(output, "semantic-controlled-review.json"), "utf8"));
    if (!gate.passed || !review.passed || review.productiveCycles < 3 || gate.model !== "qwen3:8b" || gate.toolProtocol !== "native") throw new Error("Semantic real Qwen PASS with full criterion review required; no acceptance continuation");
  }
  const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
  const bridge = new SupervisorBridge(memory); const runner = new RouteRunner(memory, bridge);
  const snapshot = async () => { const route = memory.get_route(routeId)!; return { route, state: runner.get_route_state(routeId),
    runs: route.steps.flatMap(step => memory.list_runs_for_step(step.id)), decisions: bridge.supervisorGetState(route.taskId).decisions,
    backgroundHash: hash(await readFile("I:/PersonaCore/extension/src/background/index.ts", "utf8")) }; };
  const current = await snapshot();
  if (mode === "--snapshot") await writeFile(join(output, "semantic-acceptance-before.json"), JSON.stringify(current, null, 2));
  else if (mode === "--continue") {
    const before = current.route;
    if (before.status !== "blocked" || before.steps[6].attempts !== 17 || before.blockedReason?.code !== "max_attempts") throw new Error("Exactly one continuation from original attempt 17 allowed");
    if (before.executionConfig.model !== "qwen3:8b" || before.executionConfig.toolProtocol !== "native" || before.executionConfig.permissions !== "read_write" || before.executionConfig.maxToolTurns !== 16) throw new Error("Original executor required");
    const policy = before.verificationConfig?.policies?.find(policy => policy.stepIndex === 6);
    const initial = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(bridge.supervisorGetState(before.taskId).project.rootPath, "read_only"), policy, []);
    const semanticTargets = initial.repairTargets.filter(target => target.repairability === "auto");
    if (!semanticTargets.length) throw new Error("No safely auto-repairable semantic targets");
    const additionalAttempts = Math.min(8, semanticTargets.length + 1);
    runner.events.on("state", state => console.info(JSON.stringify({ status: state.status, completed: state.completedSteps, step: state.currentStep, block: state.blockedReason })));
    runner.continue_route({ routeId, resolution, additionalAttempts }); await runner.wait(routeId);
    const after = await snapshot(); const newRuns = after.runs.filter(run => !current.runs.some(old => old.id === run.id));
    await writeFile(join(output, "semantic-acceptance-continuation.json"), JSON.stringify({ before: current, after, initial, additionalAttempts, newRuns,
      atomicRepairs: newRuns.filter(run => (run.metadata.runtime as any)?.executionKind === "repair").map(metrics),
      historyPreserved: current.runs.every(old => JSON.stringify(old) === JSON.stringify(after.runs.find(run => run.id === old.id))),
      oldDecisionsPreserved: current.decisions.every(old => after.decisions.some(decision => JSON.stringify(old) === JSON.stringify(decision))),
      executorConfigUnchanged: JSON.stringify(before.executionConfig) === JSON.stringify(after.route.executionConfig), verifierConfigUnchanged: JSON.stringify(before.verificationConfig) === JSON.stringify(after.route.verificationConfig),
      manualPersonaCoreEdits: 0, externalAcceptanceExecuteSteps: 0, newAcceptanceRoutes: 0 }, null, 2));
  } else {
    const previous = JSON.parse(await readFile(join(output, "semantic-acceptance-before.json"), "utf8"));
    await writeFile(join(output, "semantic-acceptance-audit.json"), JSON.stringify({ current,
      routeUnchanged: JSON.stringify(previous.route) === JSON.stringify(current.route), historyUnchanged: JSON.stringify(previous.runs) === JSON.stringify(current.runs),
      decisionsUnchanged: JSON.stringify(previous.decisions) === JSON.stringify(current.decisions), backgroundUnchanged: previous.backgroundHash === current.backgroundHash,
      newRuns: current.runs.filter(run => !previous.runs.some((old: any) => old.id === run.id)).map(metrics) }, null, 2));
  }
  console.info(JSON.stringify({ mode, status: memory.get_route(routeId)?.status, completed: runner.get_route_state(routeId).completedSteps, attempts: memory.get_route(routeId)?.steps[6].attempts }));
  await runner.close(); memory.close();
} else throw new Error("Use --controlled, --review, --snapshot, --audit or --continue");
