# Corrective execution semantics: diagnosis before code changes

2026-10-01. Route `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`, task `task_ec442719-8fed-4ba0-a97d-15a511b45539`, blocked at step index 6, 6/10, attempts 14/14. Model Qwen3:8b/native; bounded Bonsai/read-only verifier unchanged.

## Evidence and exact prior semantics

Diagnosis completed before implementation changes. Sources: persisted SQLite Steps/assessments, six executor/verification pairs in `native-continuation-original-prompt.json` and `native-continuation-minimal-prompt.json`, unchanged RouteRunner/AtomicAgentRuntime prompt builders. The whole outgoing system messages were not persisted: system-prefix and stalled guidance below are reconstructed from the source used by those fresh drivers, not claimed to be captured HTTP requests.

Exact current RouteStep instruction:

> Verify activity resets on both success and error, handles simultaneous requests, and initializes from session state. Add focused unit tests for activity lifecycle if needed. Fix mistakes locally without changing unrelated features.

Exact acceptanceCriteria:

```json
["Success/error and overlapping activity are covered by focused tests or explicit inspected evidence."]
```

Compact semantic comparison of the last six executor Runs:

| Component | Attempts 9–11 | Attempts 12–14 |
| --- | --- | --- |
| Actual execution instruction opening | The exact verification-oriented RouteStep instruction above | Same opening |
| Runner suffix | `Inspect actual state before editing. Fix ordinary local errors yourself. Stay within the given scope.`; criteria; `Earlier attempt results: ...` | Same suffix |
| Counterevidence delivery | Escaped verifier JSON inside earlier Run responses, each response clipped to 1000 chars, total history clipped to 8000 | Same clipped data |
| System prefix | One Supervisor instruction; do not redo completed items; inspect if criteria already satisfied; coding inspect/edit/build/test guidance | General coding agent: inspect actual files, make required edits, verify result, build/test when required; scope/constraints |
| Recovery Decision | In the Supervisor background prefix used by the original native prompt | Not in the shortened system prefix, which retained PROJECT/TASK GOAL/CONSTRAINTS; not explicitly appended to execution instruction |
| Explicit repair object/action | Absent | Absent |

The actual AtomicAgentRuntime instruction is built from the original Step, the suffix/criteria above and the serialized historical results. SupervisorBridge passes that string as `input.instruction`; native sends it as the user message. Saved Run.prompt shows it under CURRENT INSTRUCTION (the enclosing Supervisor packet is separately bounded). The leading goal and suffix are unchanged across `run_6f6415b9…`, `run_5525ccde…`, `run_dbb69b36…`, `run_f9010fc4…`, `run_1b6cbd05…`, `run_6ed90897…`.

Exact stalled guidance reconstructed from AtomicAgentRuntime:

> Progress stalled: repeated inspections returned no new evidence. Use the results already available. Perform the necessary local edit/build/test, request a genuinely different required file/range, or finish the CURRENT instruction with a final answer (verification: verdict JSON). Do not repeat identical inspections.

There **were** generic imperatives to edit (`Fix mistakes locally`, system coding guidance and stalled repair guidance), so the hypothesis “no command to edit at all” is false. However, the stronger relevant hypothesis is confirmed: rejection never became a distinct corrective goal. Run.run reissued the unchanged verification-oriented step; failed requirements remained historical data, not a structured, current repair instruction. Later prompts also omitted the recovery Decision from the system background. This is a semantic orchestration defect; the data does not prove it is the sole cause of Qwen's loop.

The verifier's complete saved rejection contains concrete missing wiring:

- `src/background/index.ts: setJabberwockToolbarActive has 0 actual calls (definitions/comments/strings are not call sites).`
- `src/background/index.ts: chrome.storage.onChanged.addListener has 0 actual calls (definitions/comments/strings are not call sites).`
- `src/background/index.ts: lifecycle literal started absent.`
- `src/background/index.ts: lifecycle literal jabberwock-supervisor: absent.`

Normalized retry assessment stored these together with positive SHA256/source observations, but RouteRunner did not read that assessment to form a repair instruction. Instead `attemptEvidence` clipped raw verifier response strings; some precise counterevidence was truncated inside invalid partial escaped JSON. That is not an explicit current remediation target.

History confirms index 5 was an **action** step: `Implement/fix toolbar activity from the same existing Supervisor request state and chrome.storage.onChanged events. Remove duplicate toolbar blink declarations/functions. Use one animation timer only; activity state must come from existing lifecycle events, never request-status polling.` Its old accepted assessment claimed storage-driven lifecycle after verifying duplicate removal; later AST counterevidence disproves actual wiring. The old accepted assessment must remain in the audit trail.

Chosen recovery model: append bounded corrective execution Runs under the failed verification's existing Step ID, with explicit repair instruction and a fresh read-only assessment afterwards. No earlier completed Step is deleted/reopened and no new top-level acceptance route is introduced. Remediation will be explicitly authorized for selected route step indexes, require read_write and a safe concrete verifier rejection. Pure observational steps excluded from that authorization cannot silently acquire edit permissions. Unconfigured normal action execution retains its previous behavior.

## Implemented repair semantics

`route-runner.ts` now reads the latest completed verification response and normalized persisted retry assessment, preserving concrete counterevidence as a separate field. It constructs a current corrective instruction rather than embedding clipped historical response strings. Fields: `goal`, `failedCriteria`, `counterevidence`, `verificationRunId`, `scope`, `constraints`, explicit `action`, recovery Decision. The same instruction is sent through JSON or native; AtomicAgentRuntime/native schemas/provider/model settings were not changed.

Exact new generic action:

> Modify the workspace as needed to resolve the failed criteria. Do not merely re-verify the same known failure. Inspect the necessary actual source, make the required incremental correction, then inspect the resulting state and return evidence. An edit or a claim of success alone is not acceptance; the read-only verifier checks the original criteria again.

Authorization is explicit: optional internal route execution config `correctiveExecution: { stepIndexes: [...] }`. No Step/Run table migration or portable protocol-format change. Existing config JSON persists the field; shared create/continue schemas validate it. Legacy routes without the field retain normal execution behavior. Selected observational steps can use corrective Runs under the same Step ID; excluded observational steps block with `remediation_not_allowed`. Read-only routes block with `repair_requires_read_write`, never acquire mutation permissions.

Bounded rejection is marked `workspaceRepairable` only when its counterevidence matches actual deterministic workspace-policy failures. Unconfirmed/model-only external counterevidence blocks with `repair_scope_unknown`; legacy verifier retry/safeToRetry retains its existing contract. Unknown/unsafe/external verdicts do not create repair goals. Large corrective instructions exceeding the existing 8000-character instruction bound block rather than silently truncate failed criteria/counterevidence. Native/JSON budgets and provider generation caps are unchanged.

`supervisor-bridge.ts` persists `executionKind: action | repair` in Run metadata, including progress and failed/interrupted Runs. Repair remains phase=execution under the existing Step. The subsequent verifier remains phase=verification/read_only/JSON; only accepted independently inspected effects advance the route. A claimed edit is insufficient. Rejections and previous false accepted assessments remain in original Runs/history.

An explicitly continued remediation cycle first re-verifies current source before issuing repair. It retains the latest recovery Decision in the repair user instruction, even though native's compact system context excludes the Decision ledger. Attempts remain lifetime counters; normal maxAttempts rules bound failed repairs.

## Regression and real controlled scenario

Six new regression cases cover JSON/native parity, explicit repair/counterevidence/criteria, actual fake-executor mutation, independent re-verification, old rejected Run retention, unchanged normal action instruction, read-only denial, excluded observational steps, non-local rejection denial, and failed claimed repair ending at max_attempts. The fixture's source AST policy checks a unique helper plus actual helper/listener invocations; history shows original action → accepted narrow helper check → verification rejection → repair → accepted verification → route advance.

First real disposable attempt with the unchanged Bonsai verifier failed **before** reaching the semantic chain: the positive helper-only verification returned neither text nor tool_calls after a 40029-ms model call. No acceptance attempt was spent. Evidence: `controlled-semantic-scenario-first-verifier.log`. Its diagnostic script initially could not serialize the final result because it parsed that error response as JSON; parsing was corrected to retain failures. The first attempt's complete in-memory Runs were not recovered after that script exit; the failure log is retained.

The controlled semantic gate was then isolated with a deterministic, read-only AST-policy test verifier **only in the disposable script**. It consumes the Runner's real inspectVerificationPolicy evidence, uses no model inference, and accepts/rejects the explicitly represented source criteria. Acceptance retains the actual original BoundedVerifierRuntime/Bonsai configuration. This isolates goal transformation without masking or changing the Bonsai positive-verdict issue.

Real executor remains fixed Qwen3:8b/native, 16 turns, the original timeout/generation configuration. Disposable in-memory route only, no persisted acceptance route. `probe.ts` initially contains:

```ts
export function setActive(active: boolean) { return active; }
export const events = new EventTarget();
```

Step A confirms the existing helper. Step B says to verify lifecycle wiring and initially report current observations. Its deterministic verification rejects missing helper invocation, listener registration and `status` literal. Runner automatically creates explicit repair Run `run_7c051231-23fa-48b3-a58d-f691c3742974`, linked to rejection `run_7fa7a16d-de0a-4e34-a11d-3fab1513702f`. Qwen then actually writes:

```ts
events.addEventListener('status', (e) => setActive(true));
```

Independent source inspection and verification Run `run_0d7fe619-f812-4456-a0b7-ba5720cef7da` accept. **Controlled verify → repair → verify PASS**, route 2/2 completed, total 19478 ms. Repair: 8 actual model calls, 7 tools, **one successful source mutation**. It recovered from a bad fs.patch argument by using fs.write. A requested build failed in the package-less disposable workspace; source criteria did not require a build and no build success is claimed. Calls/results and all six Runs are retained in `controlled-semantic-scenario.json`.

Mutation journal fs.write before/after SHA256:

- `02b43861f0eb2849610a3d91fd6a81ba59e7eab757d20bbaa67a25b3d8c104fb`
- `82f09d47397ebace1bf9fb5f23cb76f32e5d88185a082a55beaa9057d2a7c28a`

## One original acceptance-route continuation

Only after regression/build and the controlled semantic PASS, Decision `decision_f4245b64-b42a-48de-aa59-27c25cd35cf2` recorded:

> User approved one bounded continuation after corrective-execution semantics fix.

Existing route/task/Step IDs retained. `correctiveExecution.stepIndexes=[6,7,8,9]` explicitly authorizes remaining local remediation; current step budget **14 → 17**, preserving attempts. Fixed Qwen/native/read_write/16-turn execution, original timeout, fixed Bonsai/read_only verifier and all policies remain unchanged. No external acceptance execute_step.

Fresh read-only verification `run_9c5b0a7d-5379-448a-ba9f-10cb1c6bb2c5` rejects the same missing actual wiring. All three executions are now correctly tagged repair and receive the full current four-entry counterevidence, explicit generic action above, goal/failedCriteria/scope and the new recovery Decision, without the historical escaped-JSON ledger.

| Attempt | Repair Run | Model calls / tools | Elapsed | Mutations | Result |
| --- | --- | --- | --- | --- | --- |
| 15 | `run_07c838d5-9d24-43f2-a18a-7eb6bc92febb` | 10 / 10 | 22657 ms | 0 | stalled inspections |
| 16 | `run_0446fae7-4b8f-48f4-951d-b0138db3973f` | 11 / 11 | 20178 ms | 0 | stalled inspections |
| 17 | `run_b36b3914-a79a-493e-85d4-50077de28668` | 11 / 11 | 17279 ms | 0 | stalled inspections |

Actual provider usage confirms **32 requests, local_openai only**, 32 native inspection tools, zero mutation requests, zero malformed native output/provider errors, zero package-process receipts. Progress detector stops each Run; no extra timeout/turn allowance. Four real bounded verifier Runs reject source deterministically, zero verifier model calls; fresh/recheck elapsed 82/69/46/47 ms. The isolated Bonsai positive-verdict failure did not occur in this acceptance cycle because its deterministic source failures were conclusive.

Final **BLOCKED / max_attempts, 6/10, attempts 17/17**. All **58** prior Run IDs preserved; now **65** Runs. Original completed Step IDs and index-5 accepted assessment remain unchanged byte-for-byte. Verification config before/after matches exactly. Background source SHA256 remains `5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8`. **No PersonaCore changed files in this cycle**, no manual Persona edits, no PersonaCore build/test execution. Route state changedFiles still lists historical background edits from earlier Runs; that is not evidence of a new mutation.

Native API GET on 4317 independently confirms persisted final state. Evidence: `corrective-acceptance-continuation.json`, its log, `corrective-api-final-state.json`. Driver guards require attempt 14 and a controlled PASS; at attempt 17 it cannot grant another cycle. No new blind retry was made.

## Exact controlled versus real semantic difference

Full extracted user repair instructions: `corrective-semantic-diff.json`. All three real instructions are 2102 characters; control is 1412. The generic action is **byte-identical**. Both are phase execution, kind repair, read_write, fixed Qwen/native, maxToolTurns 16. System coding prompt and stalled guidance are the same. Concrete differences:

| Field | Controlled | Real acceptance |
| --- | --- | --- |
| goal | `Verify lifecycle wiring in probe.ts. The initial execution should inspect and report current state; a rejected verification is handled by a separate corrective execution.` | Exact original activity success/error/overlap/init instruction quoted in diagnosis |
| failedCriteria | One helper, explicit status listener and actual setActive(true) call | Success/error and overlapping activity covered by tests or inspected evidence |
| counterevidence | probe.ts: 0 setActive calls; 0 events.addEventListener calls; status literal absent | background: 0 setJabberwockToolbarActive calls; 0 storage listener calls; started and jabberwock-supervisor: absent |
| workspace/context | Tiny disposable helper/EventTarget file; task goal explicitly verify/repair/re-verify | Existing PersonaCore extension and Chrome session-driven lifecycle, success/error/overlap/init constraints; preserve unrelated work/completed steps |
| recovery Decision | none | Explicit approved semantics-fix continuation, preserve history/config/Bridge OFF |

Neither now means simply “repeat verification”; both explicitly require state correction. The controlled initial goal even says its first pass should inspect, yet the subsequent distinct repair succeeds. No essential counterevidence or action was clipped in the real repair instruction. Therefore the **original semantics defect was real and is fixed, but was not sufficient to eliminate the real Qwen bottleneck**. Ability to repair the tiny event fixture does not establish ability to repair the existing Chrome lifecycle implementation. No stronger causal model-versus-prompt conclusion follows from this experiment. Work stops at this honest BLOCKED as requested.

## Checks and unchanged boundaries

Focused regression/runtime/runner/verifier/provider/HTTP/MCP suite: **87 tests PASS, 11 files**. Server TypeScript build: **exit 0**. Logs: `corrective-focused-tests-serial.log` and `corrective-server-build.log`. A parallel focused pass hit an existing 20-ms verifier timeout test's exact-one-model-call assertion (zero calls when initialization consumed its deadline); the same selection passed serially without changing production or test timeout limits. No unrelated source fix was made.

Persona Bridge stays in the user-specified OFF state; every script sets auto-start OFF. Client toggle was not inspected through UI. No browser/ChatGPT automation, cloud inference/fallback, model change/download, increased maxToolTurns/timeout, new scheduler/database or toolbar-specific Runner logic. Existing API 4317 reads updated persistence but was not restarted; fresh drivers executed current source. API-loaded runtime/handlers need reload to use new config/semantics directly. Graphify is updated AST-only after code changes.
