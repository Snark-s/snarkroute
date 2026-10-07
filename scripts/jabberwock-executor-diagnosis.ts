import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SupervisorBridge } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { RouteRunner } from "../apps/server/src/jabberwock-memory/route-runner";
import { discoverLocalOpenAiModels, localOpenAiConfigs } from "../apps/server/src/providers/local-openai";
import { loadRootEnv } from "../apps/server/src/services/env-loader";
import { loadLiveModelCatalogV1 } from "../apps/server/src/routes/models";
import { modelOptionsForNodeV1 } from "../apps/server/src/services/model-catalog-v1";

loadRootEnv();
const output = resolve("apps/server/data/jabberwock");
await mkdir(output, { recursive: true });
const [mode, physicalModelId] = process.argv.slice(2);
if (!physicalModelId) throw new Error("Physical local model ID is required.");
const candidate = (await discoverLocalOpenAiModels()).find(model => model.providerModelId === physicalModelId && model.availability.status === "available");
if (!candidate) throw new Error("Requested local model is unavailable; no fallback.");
const option = modelOptionsForNodeV1("ai.text", await loadLiveModelCatalogV1("ai.text"))
  .find(model => model.provider === candidate.provider && model.providerModelId === physicalModelId);
if (!option) throw new Error("Existing live Model Gateway option is required.");
const logicalId = option.id;
const endpointConfig = localOpenAiConfigs().find(config => config.modelIds?.includes(physicalModelId)) ?? localOpenAiConfigs()[0];
const providerConfig = { baseUrl: endpointConfig.baseUrl, reasoningEffort: endpointConfig.reasoningEffort ?? "provider_default", maxConcurrency: endpointConfig.maxConcurrency };
if (mode === "--smoke") {
  const root = await mkdtemp(join(tmpdir(), "jabberwock-executor-smoke-"));
  const marker = randomUUID();
  const source = `Observed marker: ${marker}\n`;
  await writeFile(join(root, "probe.txt"), source);
  const memory = new JabberwockMemoryService(":memory:");
  const project = memory.create_project({ name: "Isolated executor smoke", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Read-only tool smoke", original_request: "Read an isolated fixture and return structured evidence." });
  const start = Date.now();
  const bridge = new SupervisorBridge(memory);
  const result = await bridge.supervisorExecuteStep({ taskId: task.id, routingMode: "fixed", model: logicalId,
    runtimeMode: "agent", permissions: "read_only", maxToolTurns: 3, signal: AbortSignal.timeout(120_000),
    instruction: 'Use exactly one fs.read tool call to read probe.txt. Then finish: content must be a JSON string encoding {"observedMarker":"the exact UUID from the file"}, with tool_actions empty. Do not guess the marker. No other tools or writes.',
    expectedOutput: 'Valid final JSON {"observedMarker":"UUID read from probe.txt"}' });
  const runs = memory.list_runs_for_step(result.stepId);
  const runtime = runs[0]?.metadata.runtime as Record<string, unknown> | undefined;
  let final: unknown; try { final = JSON.parse(result.response); } catch { final = null; }
  const passed = result.status === "completed" && (final as { observedMarker?: string } | null)?.observedMarker === marker
    && runtime?.toolCallCount === 1 && Array.isArray(runtime.toolsUsed) && runtime.toolsUsed.includes("fs.read")
    && await readFile(join(root, "probe.txt"), "utf8") === source;
  const report = { passed, logicalId, physicalModelId, provider: candidate.provider, endpoint: candidate.metadata?.baseUrl, providerConfig,
    durationMs: Date.now() - start, maxToolTurns: 3, generationCap: 2048, timeoutMs: 120_000, result, runs, personaCoreModified: false };
  const file = join(output, `executor-smoke-${physicalModelId.replace(/[^\w.-]/g, "_")}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.info(JSON.stringify({ passed, logicalId, durationMs: report.durationMs, result, runtime, file }));
  memory.close();
  if (!passed) process.exitCode = 1;
} else if (mode === "--continue") {
  const smoke = JSON.parse(await readFile(join(output, `executor-smoke-${physicalModelId.replace(/[^\w.-]/g, "_")}.json`), "utf8"));
  if (!smoke.passed || smoke.logicalId !== logicalId || smoke.endpoint !== candidate.metadata?.baseUrl || JSON.stringify(smoke.providerConfig) !== JSON.stringify(providerConfig)) throw new Error("Successful matching smoke required before continuation.");
  const database = resolve(process.env.JABBERWOCK_MEMORY_PATH || "data/jabberwock/working-memory.sqlite");
  const memory = new JabberwockMemoryService(database);
  const runner = new RouteRunner(memory, new SupervisorBridge(memory));
  const routeId = "route_fd271b28-4bd7-4bf3-b215-83a2a607cc09";
  const existing = memory.get_route(routeId);
  if (!existing || existing.status !== "blocked") throw new Error("Original BLOCKED acceptance route required.");
  const before = runner.get_route_state(routeId);
  const backgroundHash = createHash("sha256").update(await readFile("I:/PersonaCore/extension/src/background/index.ts")).digest("hex");
  runner.events.on("state", state => console.info(JSON.stringify({ status: state.status, completed: state.completedSteps, current: state.currentStep, blocked: state.blockedReason })));
  runner.continue_route({ routeId, executionConfig: { ...existing.executionConfig, routingMode: "fixed", model: logicalId },
    verificationConfig: { ...existing.verificationConfig, executionConfig: existing.verificationConfig?.executionConfig ?? { routingMode: "fixed", model: existing.executionConfig.model } },
    resolution: `User explicitly approved changing executor model and continuing the same route. Selected local ${logicalId} (${physicalModelId}), endpoint ${candidate.metadata?.baseUrl}, provider configuration ${JSON.stringify(providerConfig)}, after isolated read/tool/structured-final smoke PASS. Preserve completed steps, lifetime attempts and all evidence/history. Retain bounded verifier and its original Bonsai model/config. Independently correct missing actual toolbar wiring using existing jabberwock-supervisor: session records and storage events; initialize from session, started -> active, completed/error -> inactive, handle overlapping requests. No polling, duplicate lifecycle, cloud fallback or Persona Bridge. Require real package-process build/test receipts and inspect final source/diff.` });
  await runner.wait(routeId);
  const after = runner.get_route_state(routeId);
  const runs = memory.get_route(routeId)!.steps.flatMap(step => memory.list_runs_for_step(step.id));
  const report = { routeId, database, logicalId, physicalModelId, endpoint: candidate.metadata?.baseUrl, providerConfig, before, after, runs,
    backgroundHashBefore: backgroundHash, backgroundHashAfter: createHash("sha256").update(await readFile("I:/PersonaCore/extension/src/background/index.ts")).digest("hex"),
    externallyIssuedAcceptanceExecuteSteps: 0, manualPersonaCoreEdits: 0 };
  await writeFile(join(output, `executor-continuation-${physicalModelId.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify(report, null, 2));
  console.info(JSON.stringify({ status: after.status, routeId, completed: after.completedSteps, blocked: after.blockedReason }));
  await runner.close(); memory.close();
} else throw new Error("Use --smoke or --continue (no route creation).");
