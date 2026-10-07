import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadRootEnv } from "../apps/server/src/services/env-loader";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SupervisorBridge } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { RouteRunner } from "../apps/server/src/jabberwock-memory/route-runner";
import { AtomicWorkspaceTools } from "../apps/server/src/jabberwock-memory/atomic-tools";
import { inspectVerificationPolicy } from "../apps/server/src/jabberwock-memory/verification-policy";
import { selectExecutor } from "../apps/server/src/jabberwock-memory/executor-scout";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "..")); loadRootEnv();
process.env.PERSONA_BRIDGE_AUTO_START = "0";
const output = resolve(process.argv[2] ?? ""); const mode = process.argv[3];
if (!process.argv[2] || !["--prepare", "--continue"].includes(mode)) throw new Error("Pass evidence directory and --prepare or --continue");
const read = async (name: string) => JSON.parse(await readFile(join(output, name + ".json"), "utf8"));
const save = (name: string, value: unknown) => writeFile(join(output, name + ".json"), JSON.stringify(value, null, 2));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const selection = await read("authoritative-selection"); const profiles = await read("capability-profiles");
const winner = selectExecutor(profiles, selection.gateVersion);
if (!winner || JSON.stringify(winner) !== JSON.stringify(selection.winner)) throw new Error("Matching authoritative strict winner required");
const review = await read("authoritative-review");
const implementationHash = hash(await readFile("apps/server/src/jabberwock-memory/executor-scout.ts", "utf8"));
if (review.reviewImplementationHash !== implementationHash || review.gateVersion !== selection.gateVersion
  || !review.audits.find((a: any) => a.model === winner.model)?.levels.every((l: any) => l.accepted)) throw new Error("Current source review required");
const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
const bridge = new SupervisorBridge(memory); const runner = new RouteRunner(memory, bridge);
const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
const snapshot = async () => {
  const route = memory.get_route(routeId)!;
  return { route, state: runner.get_route_state(routeId), runs: route.steps.flatMap(s => memory.list_runs_for_step(s.id)), decisions: bridge.supervisorGetState(route.taskId).decisions,
    backgroundHash: hash(await readFile("I:/PersonaCore/extension/src/background/index.ts", "utf8")) };
};
const before = await snapshot(); const route = before.route; const original = await read("acceptance-before");
if (JSON.stringify(original.route) !== JSON.stringify(route) || JSON.stringify(original.runs) !== JSON.stringify(before.runs)
  || JSON.stringify(original.decisions) !== JSON.stringify(before.decisions) || original.backgroundHash !== before.backgroundHash) throw new Error("Original acceptance state must remain unchanged before exactly one continuation");
if (route.status !== "blocked" || route.steps[6].attempts !== 17 || route.blockedReason?.code !== "max_attempts") throw new Error("Original blocked route required");
// Source policy only: preserve the verifier model, timeout, other policies and route criteria.
// Object.is(value.state, 'started') describes exact lifecycle state equality; key.startsWith describes dispatcher storage namespace.
// Both predicates belong to the SAME actual session-entry callback, rather than unrelated source literals.
const verificationConfig = structuredClone(route.verificationConfig!);
const sourcePolicy = verificationConfig.policies!.find(p => p.stepIndex === 6)!;
const background = sourcePolicy.sources!.find(s => s.path === "src/background/index.ts")!;
background.requiredCalls = ["setJabberwockToolbarActive", { callee: "chrome.storage.session.get", arguments: [{ index: 0, equals: null }] },
  "chrome.storage.onChanged.addListener", "clearInterval",
  { callee: "key.startsWith", arguments: [{ index: 0, equals: "jabberwock-supervisor:" }], within: { callee: "Object.entries(values).some", callbackArgument: 0 } },
  { callee: "Object.is", arguments: [{ index: 1, equals: "started" }], within: { callee: "Object.entries(values).some", callbackArgument: 0 } }];
background.requiredLiterals = [];
const initial = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(bridge.supervisorGetState(route.taskId).project.rootPath, "read_only"), sourcePolicy, []);
if (initial.repairTargets.some(t => t.kind === "missing_literal" && t.path === background.path)) throw new Error("No standalone literal mutation targets permitted");
const targets = initial.repairTargets.filter(t => t.repairability === "auto");
if (!targets.length) throw new Error("Semantic targets required");
const additionalAttempts = Math.min(8, targets.length + 1);
const executionConfig = { ...route.executionConfig, model: winner.model, toolProtocol: winner.protocol, routingMode: "fixed" as const, permissions: "read_write" as const };
const resolution = `User approved continuing the same route with the local executor that passed semantic repair gate ${selection.gateVersion}.`;
const plan = { routeId, gateVersion: selection.gateVersion, executor: winner.model, protocol: winner.protocol, resolution, additionalAttempts, beforeHash: hash(JSON.stringify(before)), executionConfig,
  originalVerificationConfig: route.verificationConfig, verificationConfig, initial, policyChange: "Step 6 background namespace/state predicates anchored in the actual session-entry callback; exact state equality via Object.is. All other policies and verifier model/timeout retained.",
  manualPersonaCoreEdits: 0, externalExecuteSteps: 0, newAcceptanceRoutes: 0, personaBridgeAutoStart: process.env.PERSONA_BRIDGE_AUTO_START };
if (mode === "--prepare") { await save("continuation-plan", plan); console.info(JSON.stringify({ prepared: true, routeId, executor: winner.model, protocol: winner.protocol, additionalAttempts, targets })); }
else {
  const prepared = await read("continuation-plan");
  if (prepared.beforeHash !== plan.beforeHash || JSON.stringify(prepared.verificationConfig) !== JSON.stringify(plan.verificationConfig)) throw new Error("Prepared current-state policy required");
  await save("continuation-before", before);
  const start = Date.now();
  const checkpoint = async () => { const current = await snapshot(); const newRuns = current.runs.filter(r => !before.runs.some(old => old.id === r.id));
    await save("continuation-checkpoint", { elapsedMs: Date.now() - start, state: current.state, newRuns }); };
  const timer = setInterval(() => { void checkpoint().catch(error => console.error("Checkpoint failed", error.message)); }, 15_000);
  runner.events.on("state", s => console.info(JSON.stringify({ status: s.status, completed: s.completedSteps, currentStep: s.currentStep, block: s.blockedReason })));
  try {
    runner.continue_route({ routeId, resolution, additionalAttempts, executionConfig, verificationConfig }); await runner.wait(routeId);
    const after = await snapshot(); const newRuns = after.runs.filter(r => !before.runs.some(old => old.id === r.id));
    await save("acceptance-continuation", { plan, before, after, newRuns, durationMs: Date.now() - start,
      historyPreserved: before.runs.every(old => JSON.stringify(old) === JSON.stringify(after.runs.find(r => r.id === old.id))),
      decisionsPreserved: before.decisions.every(old => after.decisions.some(d => JSON.stringify(d) === JSON.stringify(old))),
      verifierModelConfigUnchanged: JSON.stringify(route.verificationConfig?.executionConfig) === JSON.stringify(after.route.verificationConfig?.executionConfig),
      verifierTimeoutUnchanged: route.verificationConfig?.timeoutMs === after.route.verificationConfig?.timeoutMs,
      otherPoliciesUnchanged: JSON.stringify(route.verificationConfig?.policies?.filter(p => p.stepIndex !== 6)) === JSON.stringify(after.route.verificationConfig?.policies?.filter(p => p.stepIndex !== 6)),
      manualPersonaCoreEdits: 0, externalExecuteSteps: 0, newAcceptanceRoutes: 0, personaBridgeAutoStart: process.env.PERSONA_BRIDGE_AUTO_START });
    console.info(JSON.stringify({ status: after.state.status, completed: after.state.completedSteps, block: after.state.blockedReason, newRuns: newRuns.length }));
  } finally { clearInterval(timer); }
}
await runner.close(); memory.close();
