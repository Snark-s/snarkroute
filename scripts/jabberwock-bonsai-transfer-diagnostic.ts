import { readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { loadRootEnv } from "../apps/server/src/services/env-loader";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SnarkRouteAtomicTextRuntime, SnarkRouteSupervisorModelRouter, type SupervisorAgentRuntime } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { SnarkRouteAtomicAgentRuntime, AtomicAgentRuntimeError } from "../apps/server/src/jabberwock-memory/atomic-agent-runtime";
import { AtomicWorkspaceTools } from "../apps/server/src/jabberwock-memory/atomic-tools";
import { inspectVerificationPolicy, type VerificationPolicy } from "../apps/server/src/jabberwock-memory/verification-policy";
import { buildContextPack, buildRelevantSlice } from "./jabberwock-bonsai-diagnostic-context";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "..")); loadRootEnv();
process.env.PERSONA_BRIDGE_AUTO_START = "0";
const output = resolve("apps/server/data/jabberwock", "bonsai-transfer-diagnostic-" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const save = (name: string, value: unknown) => writeFile(join(output, name + ".json"), JSON.stringify(value, null, 2));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
function stateSnapshot() {
  const route = memory.get_route(routeId)!;
  return { route, runs: route.steps.flatMap(s => memory.list_runs_for_step(s.id)), decisions: memory.get_task_context(route.taskId)!.decisions };
}
const before = stateSnapshot();
const project = memory.get_task_context(before.route.taskId)!.project_summary;
const originalRoot = resolve(project.root_path); const targetPath = "src/background/index.ts";
const original = await readFile(join(originalRoot, targetPath)); const source = original.toString("utf8");
const protectedCode = ["route-runner", "verification-policy", "bounded-verifier", "atomic-agent-runtime", "atomic-tools", "native-tools"];
const implementationHashes = Object.fromEntries(await Promise.all(protectedCode.map(async name => [name, hash(await readFile(`apps/server/src/jabberwock-memory/${name}.ts`))])));
await save("before", { ...before, originalRoot, targetPath, originalHash: hash(original), originalBytes: original.length, originalChars: source.length, implementationHashes });
const policy = before.route.verificationConfig!.policies!.find(p => p.stepIndex === 6)!;
const blockedTarget = before.route.blockedReason!.repairTarget!;
if (before.route.status !== "blocked" || blockedTarget.subject !== "setJabberwockToolbarActive" || before.route.executionConfig.model !== "bonsai-2-27b" || before.route.executionConfig.toolProtocol !== "native") throw new Error("Current blocked Bonsai/native target required; no real route changes");
const plainPolicy: VerificationPolicy = { stepIndex: 6, sources: [{ path: targetPath, uniqueSymbol: "setJabberwockToolbarActive", requiredCalls: ["setJabberwockToolbarActive"] }] };
const candidatePolicy: VerificationPolicy = { stepIndex: 6, sources: [{ path: targetPath, uniqueSymbol: "setJabberwockToolbarActive", requiredCalls: [
  { callee: "setJabberwockToolbarActive", arguments: [{ index: 0, equals: true }], within: { callee: "chrome.runtime.onMessage.addListener", callbackArgument: 0 } }
] }] };
const supportPaths = ["src/jabberwock/dispatcher.ts", "src/jabberwock/client.ts", "src/jabberwock/protocol.ts"];
const support: Record<string, Buffer> = Object.fromEntries(await Promise.all(supportPaths.map(async path => [path, await readFile(join(originalRoot, path))])));
const timeoutEnv = Number(process.env.JABBERWOCK_SUPERVISOR_TIMEOUT_MS);
const timeoutMs = timeoutEnv > 0 && Number.isFinite(timeoutEnv) ? Math.min(timeoutEnv, 3_600_000) : 600_000;
const routing = await new SnarkRouteSupervisorModelRouter().route({ routingMode: "fixed", model: "bonsai-2-27b", instruction: "Disposable diagnostic", contextPacket: "Disposable diagnostic" });
if (routing.provider !== "local_openai") throw new Error("Local Bonsai required; no fallback");
const model = new SnarkRouteAtomicTextRuntime();
const originalCriterion = { instruction: before.route.steps[6].instruction, acceptanceCriteria: before.route.steps[6].acceptanceCriteria };
const pack = buildContextPack(source, policy, [blockedTarget.failure]);
const slice = buildRelevantSlice(source);
await save("context-pack", pack); await writeFile(join(output, "context-pack.txt"), pack.text);
await save("slice-origins", slice.origins);
const baselineCases = ["A", "B", "D"];
async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `jabberwock-transfer-${name}-`));
  for (const [path, bytes] of Object.entries({ [targetPath]: name === "C" ? Buffer.from(slice.source) : original, ...support })) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
  }
  const copied = await readFile(join(root, targetPath));
  if (baselineCases.includes(name) && !original.equals(copied)) throw new Error("Exact source copy required");
  await save(name + "-fixture", { root, originalHash: hash(original), copiedHash: hash(copied), exactCopy: original.equals(copied),
    sourceBytes: copied.length, sourceChars: copied.toString("utf8").length, support: supportPaths.map(path => ({ path, hash: hash(support[path]) })), sourceOnly: true });
  return root;
}

// Analyze the actual native first request without any provider call or tool execution.
const realRepairs = before.runs.filter(r => (r.metadata.runtime as any)?.executionKind === "repair" && (r.metadata.runtime as any)?.repairTarget?.id === blockedTarget.id).slice(-2);
const realPromptAudit = [];
for (const run of realRepairs) {
  let firstRequest: any;
  const instruction = run.prompt.split("\nCURRENT INSTRUCTION\n")[1]?.split("\n\nCONSTRAINTS\n")[0];
  if (!instruction) throw new Error("Stored instruction delimiter required");
  const capture = new SnarkRouteAtomicAgentRuntime({ execute: async input => { firstRequest = { system: input.chat!.messages[0].content, user: input.chat!.messages[1].content, toolSchemas: input.chat!.tools, generation: input.generation }; throw new Error("Capture-only: provider not invoked"); } });
  try { await capture.execute({ taskId: "capture-only", stepId: "capture-only", rootPath: originalRoot, permissions: "read_write", maxToolTurns: 16, toolProtocol: "native", routing, instruction, contextPacket: run.prompt }); } catch {}
  if (!firstRequest) throw new Error("First native request capture required");
  const usage: any[] = (run.metadata.runtime as any)?.usage ?? [];
  realPromptAudit.push({ runId: run.id, storedPromptChars: run.prompt.length, firstRequest,
    firstProviderPromptChars: usage[0]?.metrics?.localOpenAi?.promptChars, firstPromptTokens: usage[0]?.providerUsage?.metrics?.prompt_tokens,
    peakPromptTokens: Math.max(...usage.map(u => u.providerUsage?.metrics?.prompt_tokens ?? 0)),
    historyLedgerInActualInitialNativePrompt: /KNOWN FACTS\n|COMPLETED STEPS\n|RELEVANT ARTIFACTS\n/.test(firstRequest.system), actualProviderCallsForCapture: 0, actualToolsForCapture: 0 });
}
await save("real-native-prompt-audit", realPromptAudit);
const exact = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(originalRoot, "read_only"), plainPolicy, []);
if (!exact.repairTargets.some(t => t.id === blockedTarget.id)) throw new Error("Original target must remain unresolved");
await save("configuration", { model: "bonsai-2-27b", protocol: "native", routing, maxToolTurns: 16, generationCap: 2048, temperature: 0, timeoutMs, maxAttemptsPerExperiment: 2,
  originalCriterion, originalSourcePolicy: policy, originalTarget: blockedTarget, candidateSemanticPolicy: candidatePolicy, personaBridgeAutoStart: process.env.PERSONA_BRIDGE_AUTO_START,
  contextIsolation: "No real history/Facts/Decisions in disposable input. Exactly copied full target and actual three Jabberwock support modules. Other imports remain external; no project/build reconstruction." });

function preservationProblems(previous: string, actual: string) {
  const parse = (text: string) => ts.createSourceFile(targetPath, text, ts.ScriptTarget.Latest, true);
  const baseline = parse(previous), after = parse(actual); const problems: string[] = [];
  for (const declaration of baseline.statements) {
    if (ts.isFunctionDeclaration(declaration) && declaration.name) {
      const corresponding = after.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === declaration.name!.text);
      if (!corresponding || corresponding.getText(after) !== declaration.getText(baseline)) problems.push(`Existing function changed/deleted: ${declaration.name.text}`);
    }
    if (ts.isImportDeclaration(declaration) && !after.statements.some(n => ts.isImportDeclaration(n) && n.getText(after) === declaration.getText(baseline))) problems.push("Existing import changed/deleted");
  }
  return problems;
}
async function experiment(name: string, localPolicy: VerificationPolicy, contextPack = "") {
  const root = await fixture(name); const baselineSource = await readFile(join(root, targetPath), "utf8");
  const attempts: any[] = []; const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tools = await AtomicWorkspaceTools.create(root, "read_only");
    const initial = await inspectVerificationPolicy(tools, localPolicy, []);
    const target = initial.repairTargets.find(t => t.subject === "setJabberwockToolbarActive" && t.kind !== "symbol_count") ?? initial.repairTargets[0];
    if (!target) break;
    if (name !== "D" && target.id !== blockedTarget.id) throw new Error("Original primary semantic target required");
    const instruction = ["CORRECTIVE EXECUTION: repair exactly ONE assigned target in this copied source-only workspace.",
      `Original criterion: ${JSON.stringify(originalCriterion)}`, `repairTarget: ${JSON.stringify(target)}`,
      `Concrete deterministic counterevidence: ${JSON.stringify(initial.counterevidence)}`,
      `Original full source-policy requirements (background context, not additional assigned targets): ${JSON.stringify(policy)}`,
      `scope: ${targetPath} only. Preserve the existing helper, imports, other protocols and unrelated behavior. Actual supporting Jabberwock modules are inspection-only copies. Other imports intentionally remain external; do not recreate the project.`,
      "Use existing native tools to read actual source, make the smallest functional repair for the original lifecycle criterion, inspect the result and return observed evidence. Do not add dead/unrelated code, dummy calls or literals to game a predicate. Do not merely re-verify. No package/build/test is required in this source-only diagnostic fixture.",
      `Attempt ${attempt} of 2.`, contextPack].filter(Boolean).join("\n");
    if (instruction.length > 8000) throw new Error("Diagnostic instruction must retain existing 8000-character repair bound");
    const contextPacket = "PROJECT\nDisposable source-only lifecycle diagnostic\n\nTASK GOAL\nRepair the one assigned source target while preserving existing behavior.\n\nCURRENT INSTRUCTION\n" + instruction;
    let latest: any = {}, providerErrors = 0; const trace: any[] = [], toolJournal: any[] = []; let observedToolCount = 0;
    const measured: SupervisorAgentRuntime = { execute: async input => {
      const entry: any = { request: { instruction: input.instruction, contextPacket: input.contextPacket, chat: input.chat, generation: input.generation }, startedAt: new Date().toISOString() };
      trace.push(entry); await save(`${name}-attempt${attempt}-model-trace`, trace);
      try { const result = await model.execute(input); entry.result = result; return result; }
      catch (error) { providerErrors++; entry.error = error instanceof Error ? error.message : String(error); throw error; }
      finally { entry.finishedAt = new Date().toISOString(); await save(`${name}-attempt${attempt}-model-trace`, trace); }
    } };
    const runtime = new SnarkRouteAtomicAgentRuntime(measured); let result: any = null, error: string | null = null;
    const attemptStart = Date.now();
    const onProgress = (metadata: Record<string, unknown>) => {
      latest = structuredClone(metadata); const count = Number(metadata.toolCallCount ?? 0);
      if (count > observedToolCount) { toolJournal.push(...(metadata.toolEvidence as any[]).slice(-(count - observedToolCount))); observedToolCount = count; }
      void save("checkpoint", { experiment: name, attempt, elapsedMs: Date.now() - attemptStart, metadata: latest, toolJournal }).catch(() => {});
    };
    console.info(JSON.stringify({ experiment: name, attempt, root, instructionChars: instruction.length, contextPackChars: contextPack.length }));
    try { result = await runtime.execute({ taskId: "disposable-diagnostic", stepId: `${name}-${attempt}`, instruction, contextPacket, routing,
      rootPath: root, permissions: "read_write", maxToolTurns: 16, toolProtocol: "native", signal: AbortSignal.timeout(timeoutMs), onProgress }); latest = result.metadata;
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); if (caught instanceof AtomicAgentRuntimeError) latest = caught.metadata; }
    const actual = await readFile(join(root, targetPath), "utf8");
    const targetVerification = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), localPolicy, []);
    const fullVerification = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), policy, []);
    const targetResolved = !targetVerification.repairTargets.some(t => t.id === target.id) && !targetVerification.repairTargets.some(t => t.kind === "source_syntax" || t.kind === "symbol_count");
    const mutations = (latest.mutationEvents ?? []).filter((e: any) => e.state === "finished" && e.success && e.beforeHash !== e.afterHash);
    const reviewProblems = preservationProblems(baselineSource, actual);
    if (mutations.some((e: any) => e.path !== targetPath)) reviewProblems.push("Mutation outside assigned target file");
    for (const [path, originalSupport] of Object.entries(support)) if (!(await readFile(join(root, path))).equals(originalSupport)) reviewProblems.push(`Inspection-only support changed: ${path}`);
    // A literal module-level toggle demonstrates count resolution but does not establish lifecycle wiring.
    const ast = ts.createSourceFile(targetPath, actual, ts.ScriptTarget.Latest, true); const moduleLiteralCalls: string[] = [];
    const scan = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === "setJabberwockToolbarActive") {
      let insideFunction = false; for (let parent: ts.Node | undefined = node.parent; parent && parent !== ast; parent = parent.parent) if (ts.isFunctionLike(parent)) insideFunction = true;
      if (!insideFunction && node.arguments[0] && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.arguments[0].kind)) moduleLiteralCalls.push(node.getText(ast));
    } ts.forEachChild(node, scan); }; scan(ast);
    if (moduleLiteralCalls.length) reviewProblems.push("Constant module-level toggle does not demonstrate lifecycle wiring: " + moduleLiteralCalls.join(", "));
    const usage = trace.map(t => t.result?.metadata?.providerUsage?.metrics).filter(Boolean);
    const promptTokens = usage.map(u => u.prompt_tokens).filter((n: unknown) => typeof n === "number");
    const passed = mutations.length > 0 && targetResolved && reviewProblems.length === 0;
    const report = { experiment: name, attempt, root, target, instruction, contextPacket, initial, actual, actualHash: hash(actual), passed, targetResolved,
      targetVerification, fullVerification, fullVerifierAccepted: fullVerification.counterevidence.length === 0, reviewProblems, result, error, metadata: latest, toolJournal,
      metrics: { durationMs: Date.now() - attemptStart, modelCalls: latest.modelCalls ?? trace.length, toolCalls: latest.toolCallCount ?? toolJournal.length, mutations: mutations.length,
        malformedOutputs: latest.malformedOutputCount ?? 0, providerErrors, initialPromptTokens: promptTokens[0] ?? null, peakPromptTokens: promptTokens.length ? Math.max(...promptTokens) : null,
        instructionChars: instruction.length, systemChars: trace[0]?.request.chat.messages[0].content.length ?? 0, contextPackChars: contextPack.length,
        providerPromptChars: trace.map(t => t.result?.metadata?.metrics?.localOpenAi?.promptChars), processCalls: latest.commandSummaries ?? [] } };
    attempts.push(report); await save(`${name}-attempt${attempt}`, report);
    console.info(JSON.stringify({ experiment: name, attempt, passed, targetResolved, fullVerifierAccepted: report.fullVerifierAccepted, metrics: report.metrics, error, reviewProblems }));
    if (passed || targetResolved) break; // No retries of an already resolved predicate or artificial retries after a weak PASS.
  }
  const report = { experiment: name, root, source: name === "C" ? "actual relevant slice" : "exact full source", context: name === "B" ? "minimal + deterministic pack" : "minimal",
    passed: attempts.some(a => a.passed), targetResolved: attempts.some(a => a.targetResolved), attempts, durationMs: Date.now() - started };
  await save(name + "-result", report); return report;
}

console.info(JSON.stringify({ output, originalHash: hash(original), sourceChars: source.length, contextPackChars: pack.text.length, sliceChars: slice.source.length, timeoutMs }));
const results = [];
results.push(await experiment("A", plainPolicy));
if (!results[0].passed) results.push(await experiment("B", plainPolicy, pack.text));
if (results.find(r => r.experiment === "B")?.passed === false) results.push(await experiment("C", plainPolicy));
// Synthetic counterexample, not a model repair: plain count admits an idle constant invocation.
const probeRoot = await fixture("probe");
await writeFile(join(probeRoot, targetPath), source + "\nsetJabberwockToolbarActive(false);\n");
const plainProbe = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(probeRoot, "read_only"), plainPolicy, []);
const semanticProbe = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(probeRoot, "read_only"), candidatePolicy, []);
const underspecified = plainProbe.counterevidence.length === 0 && semanticProbe.counterevidence.length > 0;
await save("underspecification", { underspecified, syntheticCounterexample: true, modelCalls: 0, originalPersonaEdits: 0, probeRoot, plainProbe, semanticProbe, candidatePolicy,
  evidence: "Existing trusted Jabberwock branch lives in chrome.runtime.onMessage.addListener. Scoped true invocation checks actual start activation inside the registered message callback; plain count permits constant idle invocation anywhere.",
  limits: "Current CallPredicate cannot express the trusted branch guard, request overlap, success/error cleanup, state derivation or arbitrary named refresh function bodies. Existing background storage listener/refresh function is absent; adding its name would prescribe new architecture. Candidate is a partial start-wiring criterion, not full lifecycle correctness." });
if (underspecified) results.push(await experiment("D", candidatePolicy));
const after = stateSnapshot(); const afterSource = await readFile(join(originalRoot, targetPath));
const afterImplementation = Object.fromEntries(await Promise.all(protectedCode.map(async name => [name, hash(await readFile(`apps/server/src/jabberwock-memory/${name}.ts`))])));
const originalSupportUnchanged = (await Promise.all(supportPaths.map(async path => (await readFile(join(originalRoot, path))).equals(support[path])))).every(Boolean);
const audit = { routeUnchanged: JSON.stringify(before.route) === JSON.stringify(after.route), runsUnchanged: JSON.stringify(before.runs) === JSON.stringify(after.runs), decisionsUnchanged: JSON.stringify(before.decisions) === JSON.stringify(after.decisions),
  originalPersonaUnchanged: original.equals(afterSource), originalSupportUnchanged, originalHash: hash(original), afterHash: hash(afterSource), implementationUnchanged: JSON.stringify(implementationHashes) === JSON.stringify(afterImplementation),
  actualPersonaMutations: 0, actualRouteContinuations: 0, actualDecisionsWritten: 0, personaBridgeAutoStart: process.env.PERSONA_BRIDGE_AUTO_START };
await save("comparison", results.map(r => ({ experiment: r.experiment, source: r.source, context: r.context, passed: r.passed, targetResolved: r.targetResolved,
  mutations: r.attempts.reduce((n, a) => n + a.metrics.mutations, 0), modelCalls: r.attempts.reduce((n, a) => n + a.metrics.modelCalls, 0), toolCalls: r.attempts.reduce((n, a) => n + a.metrics.toolCalls, 0),
  promptTokens: r.attempts.map(a => ({ initial: a.metrics.initialPromptTokens, peak: a.metrics.peakPromptTokens })), durationMs: r.durationMs,
  fullVerifierAccepted: r.attempts.at(-1)?.fullVerifierAccepted ?? false, failure: r.attempts.at(-1)?.error ?? r.attempts.at(-1)?.reviewProblems ?? null })));
await save("audit", audit);
console.info(JSON.stringify({ output, results: results.map(r => ({ experiment: r.experiment, passed: r.passed, targetResolved: r.targetResolved })), audit }));
memory.close();
if (Object.entries(audit).some(([k, v]) => k.endsWith("Unchanged") && v !== true)) throw new Error("Read-only original-state audit failed");
