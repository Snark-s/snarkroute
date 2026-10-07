import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { loadRootEnv } from "../apps/server/src/services/env-loader";
import { localOpenAiConfigs } from "../apps/server/src/providers/local-openai";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SupervisorBridge, SnarkRouteAtomicTextRuntime, SnarkRouteSupervisorModelRouter } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { RouteRunner } from "../apps/server/src/jabberwock-memory/route-runner";
import { AtomicWorkspaceTools } from "../apps/server/src/jabberwock-memory/atomic-tools";
import { inspectVerificationPolicy, type VerificationPolicy } from "../apps/server/src/jabberwock-memory/verification-policy";
import { reviewGateSources, selectExecutor, type ExecutorProfile } from "../apps/server/src/jabberwock-memory/executor-scout";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "..")); loadRootEnv();
process.env.PERSONA_BRIDGE_AUTO_START = "0";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const baseline = {
  "call.ts": 'export let active = false;\nexport function setActive(value: boolean) { active = value; }\n',
  "event.ts": 'export const events = new EventTarget();\nexport let started = 0;\nexport function onStarted() { started += 1; }\nevents.addEventListener("wrong-event", onStarted);\n',
  "callback.ts": 'export const events = new EventTarget();\nexport let active = false;\nexport function setActive(value: boolean) { active = value; }\nevents.addEventListener("started", () => { setActive(false); });\n'
};
const policy: VerificationPolicy = { stepIndex: 0, sources: [
  { path: "call.ts", uniqueSymbol: "setActive", requiredCalls: [{ callee: "setActive", topLevel: true, arguments: [{ index: 0, equals: true }] }] },
  { path: "event.ts", requiredCalls: [{ callee: "events.addEventListener", arguments: [{ index: 0, equals: "started" }] }] },
  { path: "callback.ts", uniqueSymbol: "setActive", requiredCalls: [{ callee: "setActive", arguments: [{ index: 0, equals: true }], within: { callee: "events.addEventListener", callbackArgument: 1, arguments: [{ index: 0, equals: "started" }] } }] }
] };
const request = "Verify the existing lifecycle examples in call.ts, event.ts and callback.ts. Repair only the single assigned semantic target, using the existing implementation. Do not modify other files or add dummy code to satisfy predicates.";
const instruction = "Initial execution: read call.ts, event.ts and callback.ts and report current state without editing. A separate corrective execution handles each assigned semantic failure.";
const criteria = ["call.ts initializes active through setActive(true); event.ts registers onStarted for started; callback.ts activates the existing state through setActive(true) inside the started listener callback."];
const semanticImplementation = await Promise.all(["verification-policy", "repair-target", "route-runner", "atomic-agent-runtime", "executor-scout"].map(async name =>
  [name, hash(await readFile(`apps/server/src/jabberwock-memory/${name}.ts`, "utf8"))]));
const resumeOutput = process.argv[2] === "--resume" ? resolve(process.argv[3]) : null;
const priorDiscovery = resumeOutput ? JSON.parse(await readFile(join(resumeOutput, "discovery.json"), "utf8")) : null;
const gateVersion = priorDiscovery?.gateVersion ?? "semantic-atomic-v2-" + hash(JSON.stringify({ baseline, policy, request, instruction, criteria, maxToolTurns: 16, outputCap: 2048, temperature: 0,
  level1Attempts: 2, level2Attempts: 6, semanticImplementation,
  review: "preserve existing state and helper implementation; no recursive helper calls; exactly one existing event registration per event/callback file; no extra files; actual target-local mutations; all three distinct productive repairs" })).slice(0, 16);
const output = resumeOutput ?? resolve("apps/server/data/jabberwock", "executor-scout-" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const save = (name: string, data: unknown) => writeFile(join(output, name + ".json"), JSON.stringify(data, null, 2));
const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
async function acceptanceSnapshot() {
  const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
  const bridge = new SupervisorBridge(memory); const route = memory.get_route(routeId)!;
  const result = { route, runs: route.steps.flatMap(s => memory.list_runs_for_step(s.id)), decisions: bridge.supervisorGetState(route.taskId).decisions,
    backgroundHash: hash(await readFile("I:/PersonaCore/extension/src/background/index.ts", "utf8")) };
  memory.close(); return result;
}
const before = resumeOutput ? JSON.parse(await readFile(join(output, "acceptance-before.json"), "utf8")) : await acceptanceSnapshot();
if (!resumeOutput) await save("acceptance-before", before);
else {
  const current = await acceptanceSnapshot();
  if (JSON.stringify(before) !== JSON.stringify(current)) throw new Error("Cannot resume a bake-off after acceptance state changed");
}
const fetchJson = async (url: string, init?: RequestInit) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
const configs = localOpenAiConfigs();
const ollama = configs.find(c => c.baseUrl === "http://127.0.0.1:11434/v1");
if (!ollama) throw new Error("Existing configured Ollama endpoint required");
const tags = await fetchJson("http://127.0.0.1:11434/api/tags");
const residency = await fetchJson("http://127.0.0.1:11434/api/ps");
const props = await fetchJson("http://127.0.0.1:8080/props");
const installed = ["qwen3:8b", "llama3:latest", "gemma3:12b", "gemma3:27b"].filter(model => tags.models.some((t: any) => t.name === model));
const additional = JSON.parse(process.env.LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON || "[]");
const endpoint = additional.find((c: any) => c.baseUrl === ollama.baseUrl);
if (!endpoint) throw new Error("Existing additional endpoint allowlist required");
endpoint.modelIds = [...new Set([...endpoint.modelIds, ...installed])];
process.env.LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON = JSON.stringify(additional);
const candidates: any[] = [];
for (const model of installed) {
  const details = await fetchJson("http://127.0.0.1:11434/api/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
  candidates.push({ model, endpoint: ollama.baseUrl, nativeAdvertised: details.capabilities.includes("tools"),
    context: Object.entries(details.model_info).find(([k]) => k.endsWith("context_length"))?.[1], contextKind: "architecture maximum; actual loaded context in residency/usage",
    resourceBytes: tags.models.find((t: any) => t.name === model).size, initiallyWarm: residency.models.some((t: any) => t.name === model), capabilities: details.capabilities });
}
const bonsaiBytes = (await stat(props.model_path)).size;
candidates.push({ model: "bonsai-2-27b", endpoint: configs[0].baseUrl, nativeAdvertised: props.chat_template_caps?.supports_tools === true,
  context: props.default_generation_settings.n_ctx, contextKind: "configured slot", resourceBytes: bonsaiBytes, initiallyWarm: !props.is_sleeping });
if (!resumeOutput) await save("discovery", { gateVersion, semanticImplementation, candidates, outputCap: 2048, temperature: 0, maxToolTurns: 16, processOnlyAllowlistAddition: installed.filter(m => !ollama.modelIds?.includes(m)),
  excluded: tags.models.filter((t: any) => !installed.includes(t.name)).map((t: any) => ({ model: t.name, reason: t.name.includes("cloud") ? "cloud" : "vision-focused outside coding candidates" })),
  initialResidency: residency, personaBridgeAutoStart: process.env.PERSONA_BRIDGE_AUTO_START });
console.info(JSON.stringify({ output, gateVersion, candidates: candidates.map(c => c.model) }));

const finishedMutations = (run: any) => (run.metadata.runtime?.mutationEvents ?? []).filter((e: any) => e.state === "finished" && e.success && e.beforeHash !== e.afterHash);
function reviewShape(actual: Record<string, string>, level: number) {
  return reviewGateSources(actual, level);
}
async function smoke(candidate: any) {
  const root = await mkdtemp(join(tmpdir(), "jabberwock-scout-smoke-")); const marker = randomUUID();
  const baseline = `marker=${marker}\nstate=STATE_PENDING\n`; await writeFile(join(root, "probe.txt"), baseline);
  const memory = new JabberwockMemoryService(":memory:");
  const project = memory.create_project({ name: "Native mutation smoke", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Read patch reread", original_request: "Native protocol smoke" });
  const start = Date.now();
  const result = await new SupervisorBridge(memory).supervisorExecuteStep({ taskId: task.id, routingMode: "fixed", model: candidate.model, runtimeMode: "agent", permissions: "read_write", toolProtocol: "native", maxToolTurns: 8, signal: AbortSignal.timeout(180_000),
    instruction: 'First call fs.read on probe.txt (do not use fs.search). Then replace the unique literal STATE_PENDING with STATE_DONE using fs.patch. Then call fs.read on probe.txt again to verify the actual change. Finish with final answer text that is a JSON object {"marker":"exact UUID read from the file","state":"STATE_DONE"}. Do not invent the UUID or claim success without tools. Do not write other files or run commands.' });
  const runs = memory.list_runs_for_step(result.stepId); const actual = await readFile(join(root, "probe.txt"), "utf8"); const runtime: any = runs[0]?.metadata.runtime ?? {};
  let final: any = {}; try { final = JSON.parse(result.response); } catch {}
  const evidence: any[] = runtime.toolEvidence ?? []; const patch = evidence.findIndex(e => e.name === "fs.patch" && e.success);
  const passed = result.status === "completed" && actual === baseline.replace("STATE_PENDING", "STATE_DONE") && final.marker === marker && final.state === "STATE_DONE"
    && evidence.slice(0, patch).some(e => e.name === "fs.read" && e.success && e.output?.includes("STATE_PENDING"))
    && evidence.slice(patch + 1).some(e => e.name === "fs.read" && e.success && e.output?.includes("STATE_DONE"))
    && finishedMutations(runs[0]).some((e: any) => e.path === "probe.txt") && runtime.nativeToolCalls?.length >= 3;
  const report = { passed, root, result, runs, actual, durationMs: Date.now() - start }; memory.close(); return report;
}
async function gate(candidate: any, protocol: "native" | "json", level: number) {
  const root = await mkdtemp(join(tmpdir(), `jabberwock-scout-L${level}-`));
  for (const [file, source] of Object.entries(baseline)) await writeFile(join(root, file), source);
  const currentPolicy = { ...policy, sources: level === 1 ? policy.sources!.slice(0, 1) : policy.sources };
  const memory = new JabberwockMemoryService(":memory:"); const text = new SnarkRouteAtomicTextRuntime();
  let providerErrors = 0, peakContext: number | null = null; const modelResponses: any[] = [];
  const bridge = new SupervisorBridge(memory, { textRuntime: { execute: async input => {
    try { const result = await text.execute(input); modelResponses.push(result); const usage: any = (result.metadata?.providerUsage as any)?.metrics;
      if (typeof usage?.prompt_tokens === "number") peakContext = Math.max(peakContext ?? 0, usage.prompt_tokens); return result;
    } catch (error) { providerErrors++; throw error; }
  } }, verificationRuntime: { execute: async input => {
    if (!input.verification?.toolEvidence.length) throw new Error("Actual full AST inspection required");
    return { response: JSON.stringify({ verdict: input.verification.counterevidence.length ? "rejected" : "accepted", reason: "Full original semantic AST policy", evidence: input.verification.evidence, counterevidence: input.verification.counterevidence }),
      metadata: { boundedVerifier: true, runtimeMode: "verifier", permissions: "read_only", modelCalls: 0, toolsUsed: ["fs.inspect"], toolEvidence: input.verification.toolEvidence } };
  } } });
  const runner = new RouteRunner(memory, bridge);
  const project = memory.create_project({ name: "Disposable controlled semantic gate", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Verify lifecycle source", original_request: request });
  const route = runner.create_route({ taskId: task.id, autoStart: false,
    executionConfig: { routingMode: "fixed", model: candidate.model, runtimeMode: "agent", permissions: "read_write", maxToolTurns: 16, toolProtocol: protocol, correctiveExecution: { stepIndexes: [0] } },
    verificationConfig: { timeoutMs: 90_000, executionConfig: { routingMode: "fixed", model: "bonsai-2-27b" }, policies: [currentPolicy] },
    steps: [{ title: "Verify semantic source", instruction, acceptanceCriteria: level === 1 ? ["call.ts initializes active through module-level setActive(true), using the existing helper."] : criteria, maxAttempts: level === 1 ? 2 : 6 }] });
  // Start with real verification, avoiding an unrelated ordinary action before the assigned repairs.
  memory.update_route_step(route.steps[0].id, { needsVerification: true });
  const initial = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), currentPolicy, []);
  const start = Date.now(); runner.events.on("state", s => console.info(JSON.stringify({ model: candidate.model, level, status: s.status, completed: s.completedSteps, block: s.blockedReason?.code })));
  runner.start_route(route.id); await runner.wait(route.id);
  const after = memory.get_route(route.id)!; const runs = after.steps.flatMap(s => memory.list_runs_for_step(s.id));
  const repairs = runs.filter(r => (r.metadata.runtime as any)?.executionKind === "repair");
  const productive = repairs.filter(r => (r.metadata.runtime as any)?.targetResolved && finishedMutations(r).some((e: any) => e.path === (r.metadata.runtime as any).repairTarget?.path));
  const actual: Record<string, string> = {}; for (const file of Object.keys(baseline)) actual[file] = await readFile(join(root, file), "utf8");
  const final = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), currentPolicy, []);
  const reviewProblems = reviewShape(actual, level);
  const unexpectedFiles = (await readdir(root)).filter(file => !Object.keys(baseline).includes(file));
  if (unexpectedFiles.length) reviewProblems.push(`Unexpected files: ${unexpectedFiles.join(", ")}`);
  if (level === 1 && (actual["event.ts"] !== baseline["event.ts"] || actual["callback.ts"] !== baseline["callback.ts"])) reviewProblems.push("Unassigned source modified");
  if (repairs.some(r => finishedMutations(r).some((e: any) => e.path !== (r.metadata.runtime as any).repairTarget?.path))) reviewProblems.push("Mutation outside assigned target");
  const distinctResolved = new Set(productive.map(r => (r.metadata.runtime as any).repairTarget.id)).size;
  const reviewAccepted = final.counterevidence.length === 0 && reviewProblems.length === 0 && distinctResolved >= (level === 1 ? 1 : 3)
    && repairs.every(r => (r.metadata.runtime as any).resultVerificationRunId && (r.prompt.match(/^repairTarget: /gm) ?? []).length === 1);
  const passed = after.status === "completed" && reviewAccepted && productive.length >= (level === 1 ? 1 : 3);
  const sum = (key: string) => runs.reduce((n, r) => n + (Number((r.metadata.runtime as any)?.[key]) || 0), 0);
  const metrics = { wallTimeMs: Date.now() - start, modelCalls: sum("modelCalls"), toolCalls: sum("toolCallCount"), mutations: runs.flatMap(finishedMutations).length,
    productiveRepairs: productive.length, noProgressAttempts: repairs.filter(r => (r.metadata.runtime as any)?.noProgress === true).length,
    failedAttempts: repairs.filter(r => r.status === "failed" || !(r.metadata.runtime as any)?.targetResolved).length,
    malformedOutputs: sum("malformedOutputCount"), providerErrors, verifierRejects: runs.filter(r => (r.metadata.runtime as any)?.phase === "verification" && r.response?.includes('"rejected"')).length,
    peakContext, unsolicitedProcessCalls: runs.flatMap(r => (r.metadata.runtime as any)?.commandSummaries ?? []),
    read: runs.some(r => ((r.metadata.runtime as any)?.toolEvidence ?? []).some((e: any) => e.name === "fs.read" && e.success)) };
  const report = { gateVersion, level, passed, finalReview: reviewAccepted, reviewProblems, root, initial, final, actual, metrics, route: after, runs, modelResponses };
  await runner.close(); memory.close(); return report;
}
const profiles: any[] = resumeOutput ? JSON.parse(await readFile(join(output, "profiles.json"), "utf8")) : [];
for (const candidate of candidates) {
  if (profiles.some(p => p.model === candidate.model)) continue;
  const routing = await new SnarkRouteSupervisorModelRouter().route({ routingMode: "fixed", model: candidate.model, instruction: "Catalog compatibility check", contextPacket: "Catalog compatibility check" });
  if (routing.provider !== "local_openai") throw new Error("Local provider required; no fallback");
  candidate.routing = routing;
  const smokeName = candidate.model.replace(/[:]/g, "-") + "-native-smoke";
  const existingSmoke = resumeOutput && (await readdir(output)).includes(smokeName + ".json");
  const probe = candidate.nativeAdvertised ? existingSmoke ? JSON.parse(await readFile(join(output, smokeName + ".json"), "utf8")) : await smoke(candidate) : null;
  if (probe && !existingSmoke) await save(smokeName, probe);
  const protocol = probe?.passed ? "native" : "json";
  const l1File = join(output, candidate.model.replace(/[:]/g, "-") + "-level1.json");
  const l1 = resumeOutput && (await readdir(output)).includes(candidate.model.replace(/[:]/g, "-") + "-level1.json") ? JSON.parse(await readFile(l1File, "utf8")) : await gate(candidate, protocol, 1);
  const renewedReview = reviewShape(l1.actual, 1);
  const l1Eligible = l1.passed && renewedReview.length === 0;
  if (!resumeOutput || !(await readdir(output)).includes(candidate.model.replace(/[:]/g, "-") + "-level1.json")) await save(candidate.model.replace(/[:]/g, "-") + "-level1", l1);
  const l2Name = candidate.model.replace(/[:]/g, "-") + "-level2";
  const existingL2 = resumeOutput && (await readdir(output)).includes(l2Name + ".json");
  const l2 = l1Eligible ? existingL2 ? JSON.parse(await readFile(join(output, l2Name + ".json"), "utf8")) : await gate(candidate, protocol, 2) : null;
  if (l2 && !existingL2) await save(l2Name, l2);
  const levels = [l1, ...(l2 ? [l2] : [])];
  const sum = (key: string) => levels.reduce((n, l) => n + Number((l.metrics as any)[key] ?? 0), 0);
  const profile = { model: candidate.model, protocol, gateVersion, testedAt: new Date().toISOString(), level1: l1Eligible, level2: l2?.passed ?? false, finalReview: l2?.finalReview ?? false,
    capabilities: { read: levels.some(l => l.metrics.read), mutation: sum("mutations") > 0, semanticTopLevelRepair: l1Eligible, sequentialSemanticRepair: l2?.passed ?? false },
    metrics: { wallTimeMs: sum("wallTimeMs"), modelCalls: sum("modelCalls"), toolCalls: sum("toolCalls"), mutations: sum("mutations"), productiveRepairs: l2?.metrics.productiveRepairs ?? 0,
      noProgressAttempts: sum("noProgressAttempts"), failedAttempts: sum("failedAttempts"), malformedOutputs: sum("malformedOutputs"), providerErrors: sum("providerErrors"), verifierRejects: sum("verifierRejects"),
      resourceBytes: candidate.resourceBytes, peakContext: levels.map(l => l.metrics.peakContext), unsolicitedProcessCalls: levels.flatMap(l => l.metrics.unsolicitedProcessCalls) },
    discovery: candidate, nativeSmokePassed: probe?.passed ?? false,
    failureReason: l2?.passed ? null : { code: !l1Eligible && renewedReview.length ? "authoritative_review_rejected" : (l2 ?? l1).route.blockedReason?.code, reviewProblems: [...(l2 ?? l1).reviewProblems, ...renewedReview], counterevidence: (l2 ?? l1).final.counterevidence } };
  profiles.push(profile); await save("profiles", profiles); console.info(JSON.stringify({ model: candidate.model, protocol, level1: l1.passed, level2: l2?.passed ?? "skipped", metrics: profile.metrics, failureReason: profile.failureReason }));
}
const winner = selectExecutor(profiles as ExecutorProfile[], gateVersion); await save("selection", { gateVersion, winner, reason: winner ? "Strict full PASS; failures, time, calls, footprint, stable ID" : "no local executor passed semantic coding gate" });
const after = await acceptanceSnapshot();
await save("acceptance-audit", { routeUnchanged: JSON.stringify(before.route) === JSON.stringify(after.route), historyUnchanged: JSON.stringify(before.runs) === JSON.stringify(after.runs), decisionsUnchanged: JSON.stringify(before.decisions) === JSON.stringify(after.decisions), backgroundUnchanged: before.backgroundHash === after.backgroundHash, after });
console.info(JSON.stringify({ output, gateVersion, selected: winner?.model ?? "none", acceptanceContinued: false }));
