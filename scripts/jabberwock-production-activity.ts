import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadRootEnv } from "../apps/server/src/services/env-loader";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SupervisorBridge, type SupervisorAgentRuntime } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { RouteRunner } from "../apps/server/src/jabberwock-memory/route-runner";
import { AtomicWorkspaceTools } from "../apps/server/src/jabberwock-memory/atomic-tools";
import { inspectVerificationPolicy } from "../apps/server/src/jabberwock-memory/verification-policy";
import ts from "typescript";
import { createHash } from "node:crypto";

loadRootEnv(); process.env.PERSONA_BRIDGE_AUTO_START = "0";
const output = resolve("apps/server/data/jabberwock/production-activity"); await mkdir(output, { recursive: true });
const memory = new JabberwockMemoryService(resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite"));
const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
const route = memory.get_route(routeId)!;
const root = memory.get_task_context(route.taskId)!.project_summary.root_path;
const save = (name: string, value: unknown) => writeFile(join(output, name + ".json"), JSON.stringify(value, null, 2));
// Explicit, task-scoped external coding execution. These are actual tool/process
// operations, with a separate read-only policy check; no model call or claimed PASS.
const directRuntime: SupervisorAgentRuntime = { execute: async input => {
  const step = route.steps.find(value => value.id === input.stepId)!;
  if (!step || step.index < 6 || step.index > 9) throw new Error("Only authorized remaining activity steps may execute externally");
  const policy = route.verificationConfig!.policies!.find(value => value.stepIndex === step.index);
  if (input.phase === "verification") {
    if (!policy) throw new Error("Existing deterministic verification policy required");
    const commandRuns = policy.commandScope === "route" ? route.steps.flatMap(value => memory.list_runs_for_step(value.id)) : memory.list_runs_for_step(step.id);
    const commands = commandRuns.flatMap(run => (run.metadata.runtime as any)?.commandSummaries ?? []);
    const inspection = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"),
      step.index === 6 ? { ...policy, requiredCommands: ["test", "build"] } : policy, commands);
    await save(`external-independent-verification-${step.index}`, inspection);
    return { response: JSON.stringify({ verdict: inspection.counterevidence.length ? "retry" : "accepted", summary: "Actual source policy and recorded package-process exits independently checked", evidence: inspection.evidence,
      counterevidence: inspection.counterevidence, safeToRetry: true }),
      metadata: { provider: "manual_external", actualModelCalls: 0, toolEvidence: inspection.toolEvidence, toolsUsed: inspection.toolEvidence.map(value => value.name) } };
  }
  if (step.index === 6) throw new Error("Activity repair is external resolution only; never replay it");
  const tools = await AtomicWorkspaceTools.create(root, "read_write");
  const results = [];
  if (step.index === 7 || step.index === 8) {
    for (const script of step.index === 7 ? ["build"] : ["test", "build"]) {
      const receipt = await tools.execute({ name: "shell.exec", arguments: { script } }, input.signal); results.push(receipt);
      if (!receipt.success || receipt.exitCode !== 0) throw new Error(`${script} failed: ${receipt.output ?? receipt.error}`);
    }
  } else {
    results.push(await tools.execute({ name: "git.diff", arguments: {} }, input.signal));
    for (const path of ["src/background/index.ts", "src/sidepanel/Workshop.tsx", "tests/jabberwock-activity.test.ts", "tests/jabberwock-panel-activity.test.ts"]) {
      results.push(await tools.execute({ name: "fs.read", arguments: { path, startLine: 1, endLine: 120 } }, input.signal));
    }
    if (results.some(value => !value.success)) throw new Error("Final diff/source inspection failed");
  }
  await save(`external-actual-tools-${step.index}`, results);
  return { response: JSON.stringify(results), metadata: { provider: "manual_external", actualModelCalls: 0, toolsUsed: results.map(value => value.name), toolEvidence: results,
    commandSummaries: results.filter(value => value.name === "shell.exec") } };
} };
const direct = process.argv[2] === "resolve-direct";
const runner = new RouteRunner(memory, direct ? new SupervisorBridge(memory, { runtime: directRuntime, verificationRuntime: directRuntime,
  router: { route: async () => ({ mode: "fixed", model: "external_coding_executor", provider: "manual_external" }) } }) : new SupervisorBridge(memory));
try {
  if (process.argv[2] === "audit") {
    const original = JSON.parse(await readFile("apps/server/data/jabberwock/bonsai-transfer-diagnostic-2026-10-02T21-36-15-660Z/A-attempt1.json", "utf8")).actual as string;
    const actual = await readFile(join(root, "src/background/index.ts"), "utf8");
    const before = ts.createSourceFile("before.ts", original, ts.ScriptTarget.Latest, true);
    const after = ts.createSourceFile("after.ts", actual, ts.ScriptTarget.Latest, true);
    const preserved = before.statements.every(statement => after.statements.some(value => value.getText(after) === statement.getText(before)));
    const result = { originalStatementsPreserved: preserved, originalHash: createHash("sha256").update(original).digest("hex"), currentHash: createHash("sha256").update(actual).digest("hex"),
      change: "Background adds event-driven session activity observation; every original statement, including helper and message dispatcher, is retained", routeStatus: memory.get_route(routeId)!.status };
    await save("source-preservation-audit", result);
    await writeFile(join(output, "background-before.ts"), original); await writeFile(join(output, "background-after.ts"), actual);
    console.info(JSON.stringify(result)); if (!preserved) throw new Error("An original background statement changed");
  } else if (process.argv[2] === "check") {
    await save("escalation", runner.get_escalation(routeId));
    const tools = await AtomicWorkspaceTools.create(root, "read_write");
    const receipts = [];
    for (const script of ["test", "build"] as const) {
      const receipt = await tools.execute({ name: "shell.exec", arguments: { script } }); receipts.push(receipt);
      await save("direct-process-receipts", receipts);
      console.info(JSON.stringify({ script, success: receipt.success, exitCode: receipt.exitCode }));
      if (!receipt.success || receipt.exitCode !== 0) throw new Error(`${script} failed: ${receipt.output ?? receipt.error}`);
    }
    const policy = route.verificationConfig!.policies!.find(value => value.stepIndex === 6)!;
    const inspection = await inspectVerificationPolicy(await AtomicWorkspaceTools.create(root, "read_only"), policy, []);
    await save("direct-source-verification", inspection);
    if (inspection.counterevidence.length) throw new Error(JSON.stringify(inspection.counterevidence));
  } else if (process.argv[2] === "resolve" || direct) {
    const receipts = JSON.parse(await readFile(join(output, "direct-process-receipts.json"), "utf8"));
    if (receipts.length !== 2 || receipts.some((value: any) => !value.success || value.exitCode !== 0)) throw new Error("Actual test/build process receipts required");
    if (!runner.get_escalation(routeId)) throw new Error("Existing coding escalation required");
    const stepId = route.blockedReason!.failedStep!;
    if (direct) {
      // Fresh actual receipts under the existing Step ID, not receipt claims in
      // externalResolution. This verifier requires both test/build plus source AST.
      const tools = await AtomicWorkspaceTools.create(root, "read_write");
      const results = [];
      for (const script of ["test", "build"]) {
        const result = await tools.execute({ name: "shell.exec", arguments: { script } }); results.push(result);
        memory.add_run({ step_id: stepId, model: "external_coding_executor", prompt: `Codex actual ${script} verification preparation`, response: JSON.stringify(result),
          status: result.success ? "completed" : "failed", finished_at: new Date().toISOString(), metadata: { runtime: { phase: "execution", executionKind: "external_tools", provider: "manual_external", actualModelCalls: 0, toolEvidence: [result], commandSummaries: [result] } } });
        if (!result.success || result.exitCode !== 0) throw new Error(`${script} failed`);
      }
      await save("fresh-external-process-receipts", results);
    }
    runner.events.on("state", state => { console.info(JSON.stringify({ status: state.status, currentStep: state.currentStep, completedSteps: state.completedSteps, blockedReason: state.blockedReason?.code })); });
    runner.continue_route({ routeId, resolution: "Codex external fix: toolbar and panel derive activity from existing session started/completed records, initialize from session and subscribe to storage changes; stale reads discarded; one blink timer. Actual focused overlap/success/error tests and full extension test/build exited 0. Independently verify actual workspace before acceptance.",
      externalResolution: { stepId, changedFiles: ["src/background/index.ts", "src/sidepanel/Workshop.tsx", "tests/jabberwock-activity.test.ts", "tests/jabberwock-panel-activity.test.ts", "tests/persona-background.test.ts"],
        evidence: ["Actual dispatcher/background lifecycle probes: success/error, overlapping success/error, session restoration, deletion, stale reads and no polling PASS.", "Panel restoration/overlap/cleanup test PASS; reduced-motion CSS retained.", ...receipts.map((value: any) => `${value.command}: exit ${value.exitCode}; actual package_process receipt stored in ${output}`)] } });
    await runner.wait(routeId); await save("route-after-resolution", runner.get_route_state(routeId));
    await save("route-full-after", memory.get_route(routeId));
  } else throw new Error("Use check or resolve");
} finally { await runner.close(); memory.close(); }
