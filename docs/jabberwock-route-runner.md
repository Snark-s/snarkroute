# Jabberwock Route Runner

The Supervisor owns a durable, ordered route under an existing Task. Creating a route starts execution by default and returns immediately. Browser lifetime and HTTP request lifetime do not control execution. Clients use the Supervisor HTTP API or the existing authenticated MCP endpoint, never a ChatGPT composer.

## Execution

`RouteRunner → SupervisorBridge.supervisorExecuteStep → existing router → existing agent/text runtime → existing provider gate`.

Every route item is an existing working-memory `steps` row. Execution and read-only assessment append `runs` to that same step. The bridge retains the standalone `execute_step` behavior, including default/auto/fixed routing and assessment. Route configuration uses those same runtime, routing, permission and model settings. Coding routes should use `runtimeMode: "agent"`; text routes can only assess textual results.

The runner executes one item, inspects acceptance criteria through a read-only runtime invocation, persists the assessment, then advances or repairs the current state. Ordinary patch/build/test problems belong to the executor's local loop. Default `maxAttempts` is 3. A continuation records a decision and grants a further bounded budget while retaining lifetime attempts and completed progress. An optional `executionConfig` in the continuation explicitly authorizes a model/configuration change using the existing routing schema.

Production verification now uses `BoundedVerifierRuntime`, independently of the coding runtime. It reuses the same Supervisor router, text provider and provider gate. It sees only the current instruction/criteria, the last execution evidence (4,000 characters), deterministic inspection and up to six short read results; it never receives the full Task history. It allows three model calls, six read/search/diff tools, at most 120 lines per read and 1,200 output characters per result. Generation is capped at 768 tokens with temperature 0. The Route Runner applies a separate 90-second phase timeout (explicit maximum 180 seconds). It accepts only a structured `accepted|rejected|unknown` verdict with reason, evidence and counterevidence. Unknown, malformed exhaustion and timeout stop as `verification_unknown`; they never accept or automatically relaunch execution. Concrete rejected criteria trigger an incremental corrective execution within the existing attempt budget.

Both agent loops request JSON output through the existing text runtime. The local OpenAI adapter forwards `response_format: {type: "json_object"}` to the backend, which supports constrained JSON (see [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)). Executor generations have a separate 2,048-token cap, verifier generations 768. This changes response configuration, not the fixed model. Truncated/invalid responses still cannot establish completion. Legacy standalone text execution does not request these agent bounds.

Optional `verificationConfig` is persisted in an additive `supervisor_routes.verification_config` column. `executionConfig` inside it contains only routing/model/constraints and overrides verification alone; the executor keeps its original configuration. There is no model fallback. `timeoutMs` changes the verification budget. `policies` select zero-based `stepIndex` and optionally required package commands or source probes. Source probes use a bounded full-file read and TypeScript AST to count actual calls and unique implementations, excluding comments and strings. Build/test policies require actual process receipts with command, exit code 0, stdout/stderr summaries and duration. `commandScope: "route"` also permits receipts from earlier route items. Source gates establish necessary facts; the verifier still assesses behavior and looks for counterevidence. Route state includes both configurations and recent verification Run ID, actual routed model, runtime, verdict and duration. A deterministic rejection can use zero model calls.

Example explicit continuation configuration (does not change the executor):

```json
{
  "resolution": "Inspect actual effects and repair unmet criteria",
  "verificationConfig": {
    "timeoutMs": 90000,
    "executionConfig": { "routingMode": "fixed", "model": "explicitly-approved-model" },
    "policies": [{ "stepIndex": 7, "requiredCommands": ["build"] }]
  }
}
```

Before each file mutation the agent commits the intended before/after SHA-256 hashes into its active Run. Interrupted writes are reconciled against actual files before another write is considered. A verified applied change can complete the item without replay. Unknown effects block the route. An explicit external resolution is persisted; the read-only verifier must inspect actual state again before accepting it or approving an incremental repair. Shell scripts have potentially broader effects, so an interrupted script without a confirmed outcome is treated conservatively.

Package scripts retain the existing allowlist (`build`, `test`, `lint`, `typecheck`). An IPC-owned subprocess helper terminates the process tree on cancel, timeout or parent disconnect. It adds no inference engine or scheduler. Tool output, project paths and history are bounded. File reads support line ranges; tracked diff also identifies untracked files for explicit inspection.

## Persistence and recovery

The existing `working-memory.sqlite` gains one additive table, `supervisor_routes`, with task ownership, status, current step, timestamps, compact blocker, summary, existing execution configuration, autostart flag and owning process ID.

Existing `steps` gain `route_id`, `route_index`, `title`, `acceptance_criteria`, `attempts`, `max_attempts`, `dependencies`, `needs_verification`, `route_error` and `recovery_resolution`. There is no second step table or database. Existing Run metadata stores phase, tool evidence and mutation journal. Existing `decisions`, `facts` and `artifacts` remain authoritative. Migrations are idempotent, additive, transactional, and use SQLite busy handling; tests migrate a real legacy schema without replacing old rows.

A SQLite claim prevents two owners of a route and excludes another active execution in the same workspace, including different project IDs registered for the same root path. Provider limits stay in the existing runtime. A process registry supplies cancellation and excludes live in-process owners from recovery. Startup does not steal routes from another live owning process. Recovered routes waiting for an in-process owner resume on its completion event; an owner in another process requires starting the pending route once that process releases it. Normal deployments use one Supervisor process; cancellation must be requested through the owning process.

On graceful shutdown the HTTP `preClose` hook closes route SSE streams and aborts the controller before waiting for HTTP connections; tools settle, and a running route remains recoverable on disk. On restart, abandoned Runs become `interrupted`, completed items stay completed, and the interrupted item is assessed before execution can resume. BLOCKED and cancelled routes remain terminal until their explicit supported operation. Autostart routes persisted before the first claim are also recovered. Explicitly unstarted routes (`autoStart: false`) remain pending.

## HTTP operations

Base: `/api/jabberwock/supervisor` with the existing local-mode, loopback and origin checks.

| Operation | HTTP |
| --- | --- |
| `create_route` | `POST /routes` |
| `start_route` | `POST /routes/:routeId/start` |
| `get_route_state` | `GET /routes/:routeId` |
| `continue_route` | `POST /routes/:routeId/continue`, body `{ "resolution": "...", "executionConfig": { "routingMode": "fixed", "model": "approved-model" } }` (configuration optional) |
| `cancel_route` | `POST /routes/:routeId/cancel` |
| State events | `GET /routes/:routeId/events` (SSE) |

```json
{
  "taskId": "task_...",
  "steps": [
    {
      "title": "Implement and check the indicator",
      "instruction": "Inspect the existing lifecycle, implement the indicator, read the result, build/test, repair errors, inspect diff.",
      "acceptanceCriteria": ["The existing lifecycle controls activity", "Build and focused tests pass"],
      "maxAttempts": 3
    }
  ],
  "executionConfig": {
    "routingMode": "fixed",
    "model": "bonsai-2-27b",
    "runtimeMode": "agent",
    "permissions": "read_write",
    "maxToolTurns": 16
  }
}
```

`autoStart` defaults to true. If its initial claim fails, the rejected creation is marked failed and cannot execute later through recovery; clients can retry the request after the workspace is free. Deliberately unstarted routes retain their explicit start behavior. Dependencies are optional zero-based indexes of earlier items. HTTP creation body is limited to 128 KiB. Capabilities retain version 1 and previous features and now advertise `routeRunner`, `persistentRoutes`, `routeEvents` and the five operations. The compact state includes counts, item summaries, retries, structured blocker/question/options, artifacts, known changed files and command exit results; it excludes raw prompts/responses and routing traces.

The existing `/mcp` uses its current bearer authentication and transport. It registers `jabberwock_create_route`, `jabberwock_start_route`, `jabberwock_get_route_state`, `jabberwock_continue_route`, `jabberwock_cancel_route`, plus capabilities and project/task helpers against the same Supervisor and runner. Existing AE tools and HTTP Supervisor operations are retained. There is no new browser transport, extension dispatch lifecycle or automatic message delivery for routes.

## Verification

Tests cover ordered automatic execution, acceptance and next-step transition, retries, actual mutation followed by timeout, persisted mutation intent, exhausted budgets, continuation decisions, cancellation, process-tree termination, parent-disconnect termination, legacy schema migration, recovery, retained progress, autostart recovery, ownership, HTTP operations, native MCP operations and legacy default/fixed execution.

The real acceptance driver is `scripts/jabberwock-route-acceptance.ts`. It creates exactly one 10-item PersonaCore indicator route using the normal router and local Bonsai, persists it in the existing working memory, waits on runner events/completion, and writes `data/jabberwock/acceptance-<routeId>.json`. It never issues external per-item `execute_step` calls. A process restart can resume the same route:

```powershell
corepack pnpm exec tsx scripts/jabberwock-route-acceptance.ts I:/PersonaCore/extension
corepack pnpm exec tsx scripts/jabberwock-route-acceptance.ts I:/PersonaCore/extension --resume route_...
corepack pnpm exec tsx scripts/jabberwock-route-acceptance.ts I:/PersonaCore/extension --continue route_...
```

## Limits

Acceptance criteria are evaluated against observable tool evidence, not a general formal proof system. Behavioral criteria require actual calls, events and initialization/cleanup evidence; definitions alone are insufficient. Explicit source/command policies add deterministic necessary conditions. Unknown mutation effects remain `unverified_effects` and block before verification; a failed file tool with an intended content hash is reconciled even if it reports failure after applying the write. Unknown script effects require external evidence or a decision. The runner does not silently change fixed routing or replay writes. Executor speed and capabilities still limit coding progress. An explicitly injected legacy verification runtime retains its three-check compatibility behavior; the production default uses the separate bounded verifier described above. Standalone legacy `execute_step` behavior is preserved.

Routes are ordered and bounded (up to 100 items, up to 16 internal model/tool turns per invocation). Public ORP documents, storage keys, `.snarknode` packages and provider economics/provenance formats are unchanged. Extension progress UI is optional; Supervisor SSE supplies events without adding status polling. The running production server needs to load the updated code to expose the new endpoints/tools.

## Changed implementation files

- `apps/server/src/jabberwock-memory/{route-types,route-input,route-runner}.ts`: route types, validated creation and orchestration.
- `apps/server/src/jabberwock-memory/{storage,service,supervisor-bridge,atomic-agent-runtime,atomic-tools,index}.ts`: persistence, reusing steps/runs, tool journaling, bounded coding/verification loop and exports.
- `apps/server/src/routes/jabberwock-supervisor.ts`, `apps/server/src/app.ts`: HTTP operations, events and lifecycle wiring.
- `apps/server/src/mcp/{server,jabberwock-tools}.ts`: native tool registration using the existing transport.
- `scripts/jabberwock-script-worker.mjs`, `scripts/jabberwock-route-acceptance.ts`: owned script process helper and real acceptance driver.
- Tests in the same memory, routes and MCP directories: new runner/tools/HTTP/MCP suites, additive-migration coverage, verification-format coverage and explicit routing in legacy fixtures.

Verification counts and the real acceptance outcome are recorded in [the implementation report](jabberwock-route-runner-report.md).
