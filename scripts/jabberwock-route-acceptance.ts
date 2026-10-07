import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JabberwockMemoryService } from "../apps/server/src/jabberwock-memory/service";
import { SupervisorBridge } from "../apps/server/src/jabberwock-memory/supervisor-bridge";
import { RouteRunner } from "../apps/server/src/jabberwock-memory/route-runner";
import { loadRootEnv } from "../apps/server/src/services/env-loader";

// One create_route call. There are deliberately no externally issued execute_step calls.
loadRootEnv();
const personaRoot = resolve(process.argv[2] ?? "I:/PersonaCore/extension");
const database = resolve(process.env.JABBERWOCK_MEMORY_PATH?.trim() || "apps/server/data/jabberwock/working-memory.sqlite");
const memory = new JabberwockMemoryService(database);
const runner = new RouteRunner(memory, new SupervisorBridge(memory));
const continuing = process.argv[3] === "--continue";
const resumeId = continuing || process.argv[3] === "--resume" ? process.argv[4] : undefined;
if ((continuing || process.argv[3] === "--resume") && !resumeId) throw new Error("Existing route ID is required.");
const project = memory.list_projects().find(candidate => candidate.root_path === personaRoot)
  ?? memory.create_project({ name: "PersonaCore extension", root_path: personaRoot, description: "Authorized activity-indicator acceptance route" });
const task = resumeId ? memory.get_task(memory.get_route(resumeId)!.taskId)! : memory.create_task({ project_id: project.id, title: "Jabberwock activity indicator",
  original_request: "Add/fix the Jabberwock activity indication in PersonaCore Workshop and extension toolbar. Reuse the existing Supervisor request lifecycle and storage events. Stop indication on success/error. Remove duplicated activity code. Build/test and inspect diff. No polling for request status, parallel lifecycle, browser automation, or automatic ChatGPT composer submission. Preserve unrelated existing changes." });
const steps = [
  ["Inspect request lifecycle", "Find and read the existing Jabberwock dispatcher/client request lifecycle in src/jabberwock. Find where started/completed state is persisted, including failure handling.", "Actual dispatcher/client files inspected and start/success/error lifecycle identified."],
  ["Inspect Workshop icon", "Find and read the Jabberwock entry/icon and activity state in src/sidepanel/Workshop.tsx and relevant CSS. Inspect only, do not edit yet.", "Actual Workshop button/icon and current activity subscription identified."],
  ["Connect busy state", "Connect or verify Workshop Jabberwock busy state through existing chrome.storage.session started/completed request records and chrome.storage.onChanged events. Fix local activity lifecycle mistakes if present. Do not introduce polling or a second lifecycle.", "Workshop Jabberwock icon activity uses the existing dispatcher state and storage events, with proper cleanup."],
  ["Panel pulse", "Add or verify a pulse/blink on the Jabberwock Workshop icon while busy using the existing activity class. Preserve reduced-motion handling and avoid duplicate CSS.", "Exactly one panel pulse rule exists and is conditional on Jabberwock busy state."],
  ["Inspect toolbar", "Read src/background/index.ts and the extension manifest. Find chrome.action toolbar activity code and any duplicate declarations/functions. Inspect only.", "Toolbar action and any duplicate activity code identified from actual files."],
  ["Toolbar indication", "Implement/fix toolbar activity from the same existing Supervisor request state and chrome.storage.onChanged events. Remove duplicate toolbar blink declarations/functions. Use one animation timer only; activity state must come from existing lifecycle events, never request-status polling.", "Toolbar indication has exactly one implementation, subscribes to existing state, and stops and clears its timer when no requests are active."],
  ["Verify completion and error", "Verify activity resets on both success and error, handles simultaneous requests, and initializes from session state. Add focused unit tests for activity lifecycle if needed. Fix mistakes locally without changing unrelated features.", "Success/error and overlapping activity are covered by focused tests or explicit inspected evidence."],
  ["Build extension", "Run shell.exec build at the workspace root. Inspect the build result and fix ordinary local build errors within the authorized activity-indicator scope if needed. Read the actual changed files.", "Extension build script completed with exit code 0, backed by tool output."],
  ["Test and repair", "Run shell.exec test and shell.exec build at the workspace root. Fix activity-indicator test/build errors locally and rerun. Do not disable or weaken tests.", "Extension test and build scripts completed with exit code 0, backed by tool output."],
  ["Inspect final diff", "Inspect git.diff and actual activity code. Verify no duplicate declarations, no request-status polling, and no second lifecycle were introduced. Summarize changed files and validation.", "Final diff inspected; panel and toolbar indication use one existing lifecycle; no duplicated activity code or polling added."]
].map(([title, instruction, criterion]) => ({ title, instruction, acceptanceCriteria: [criterion] }));

const route = resumeId ? memory.get_route(resumeId)! : runner.create_route({ taskId: task.id, steps, executionConfig: {
  routingMode: "fixed", model: process.env.JABBERWOCK_ACCEPTANCE_MODEL ?? "bonsai-2-27b", runtimeMode: "agent", permissions: "read_write", maxToolTurns: 16
} });
console.info(JSON.stringify({ routeId: route.id, taskId: task.id, database, steps: steps.length }));
runner.events.on("state", state => console.info(JSON.stringify({ routeId: state.id, status: state.status,
  completedSteps: state.completedSteps, currentStep: state.currentStep, blockedReason: state.blockedReason })));
if (continuing) runner.continue_route({ routeId: resumeId!, resolution:
  "Replace the previous heavy verifier with bounded read-only verification using the SAME fixed Bonsai model. The prior toolbar assessment is invalid: the helper has no actual calls or storage listener. Preserve six completed steps and lifetime history. The current completion/error step must inspect and correct actual toolbar wiring through the executor: use existing jabberwock-supervisor: session records, started/completed/error behavior, initialize from session, subscribe to storage events, stop animation when no started requests remain, support overlap, no polling or second lifecycle. Independently verify actual calls/events and real process receipts before acceptance.",
  verificationConfig: { timeoutMs: 90_000, policies: [
    { stepIndex: 6, sources: [{ path: "src/background/index.ts", uniqueSymbol: "setJabberwockToolbarActive",
      requiredCalls: ["setJabberwockToolbarActive", "chrome.storage.session.get", "chrome.storage.onChanged.addListener", "clearInterval"],
      requiredLiterals: ["started", "jabberwock-supervisor:"] }, { path: "src/jabberwock/dispatcher.ts", requiredLiterals: ["started", "completed"] }] },
    { stepIndex: 7, requiredCommands: ["build"] },
    { stepIndex: 8, requiredCommands: ["test", "build"] },
    { stepIndex: 9, commandScope: "route", requiredCommands: ["test", "build"], sources: [{ path: "src/background/index.ts", uniqueSymbol: "setJabberwockToolbarActive",
      requiredCalls: ["setJabberwockToolbarActive", "chrome.storage.session.get", "chrome.storage.onChanged.addListener", "clearInterval"],
      requiredLiterals: ["started", "jabberwock-supervisor:"] }, { path: "src/sidepanel/Workshop.tsx",
      requiredCalls: ["chrome.storage.session.get", "chrome.storage.onChanged.addListener", "chrome.storage.onChanged.removeListener"],
      requiredLiterals: ["started", "jabberwock-supervisor:"] }] }
  ] }
});
else if (resumeId) runner.recover();
const stop = () => { void runner.close(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
await runner.wait(route.id);
const state = runner.get_route_state(route.id);
const reportPath = join(resolve("apps/server/data/jabberwock"), `acceptance-${route.id}.json`);
await writeFile(reportPath, JSON.stringify({ ...state, personaRoot, database, externallyIssuedExecuteSteps: 0 }, null, 2));
console.info(JSON.stringify({ status: state.status, routeId: route.id, reportPath, blockedReason: state.blockedReason }));
await runner.close(); memory.close();
