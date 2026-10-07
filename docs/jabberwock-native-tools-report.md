# Jabberwock native tools: infrastructure PASS, acceptance BLOCKED

2026-10-01. Existing route `route_fd271b28-4bd7-4bf3-b215-83a2a607cc09`, task `task_ec442719-8fed-4ba0-a97d-15a511b45539`. Final status **BLOCKED / max_attempts, 6/10**. Native mutation smoke passes; Qwen still performs inspections rather than corrective edits in the real task. No further attempts are running.

## Implementation

The existing chain remains RouteRunner → SupervisorBridge → AtomicAgentRuntime → model gateway/router → local_openai. No new scheduler, runner, database, provider abstraction or dependencies.

- `atomic-agent-runtime.ts`: optional `toolProtocol: native | json | auto`. Omission retains JSON. Native sends standard function schemas with `tool_choice: auto`, parses assistant `message.tool_calls`, executes the existing AtomicWorkspaceTools and sends assistant/tool message bundles on the next turn. Original call IDs are preserved. Duplicate/replayed IDs, malformed messages/arguments and manual JSON tool simulation fail without protocol/provider fallback.
- `native-tools.ts`: schemas adapt permission-filtered registry definitions. `fs.list`, `fs.search`, `fs.read`, `fs.write`, `fs.patch`, `git.status`, `git.diff`, `shell.exec` are available within existing permissions. Wire names replace dots with underscores, e.g. `fs_read` → existing `fs.read`. Shell scripts remain restricted to build/test/lint/typecheck. Read-only omits mutation schemas; malicious requests still pass through the existing permission checks.
- `supervisor-bridge.ts` / `providers/local-openai.ts`: forward messages/tools/tool_choice through the existing adapter and return the raw assistant message. Native generation uses 2048 tokens, temperature 0 and no JSON response_format. JSON retains its existing structured-envelope request. Standard request/response behavior follows [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) and [tool calling](https://docs.ollama.com/capabilities/tool-calling).
- `auto` requires explicit per-model confirmation in endpoint `nativeToolModelIds`, restricted to the endpoint's installed-model allowlist. Generic catalog tools metadata alone does not enable it. Qwen was configured as confirmed only after a real mutation smoke PASS. Actual acceptance cycles explicitly selected native.
- Route execution config, HTTP step schema and shared create/continue schemas accept the optional protocol. It is persisted in existing config JSON; no DB or portable route-format migration. RouteRunner verification explicitly remains JSON/read_only with the original BoundedVerifierRuntime, fixed Bonsai and original policies.

Both modes share tools.execute, mutationIntent, SHA256 journal/onProgress persistence, interrupted-write verification, cancellation, turn bounds, progress detector, receipts and evidence. Native history clipping retains complete assistant/result bundles and their IDs. A model-request failure after mutation preserves the journal; the route's existing recovery verifies actual effects rather than blindly replaying writes.

After the controlled prompt experiment, native received a shorter general coding prompt. It retains workspace/permission, project/task scope, constraints, current instruction/criteria/recent attempt evidence, actual native tool history and stalled-progress guidance. It avoids repeating the Supervisor evidence ledger in the system message. JSON prompting and bounded verifier were not changed by that prompt adjustment. No toolbar-specific implementation recipe was added to the runtime prompt.

## Real disposable JSON/native comparison

Fixed **qwen3:8b**, `http://127.0.0.1:11434/v1`, explicit `reasoning_effort: none`. Each pair uses the same temporary workspace, UUID, baseline, instruction and limits: 8 tool turns, 180 s, 2048 generation tokens, temperature 0. Baseline restored between modes. No PersonaCore files are used. Warmup is recorded separately and excluded from each measured execution.

Required sequence: native fs.read of probe.txt → fs.patch STATE_PENDING to STATE_DONE → fs.read again → final JSON containing the exact UUID and STATE_DONE. PASS checks actual file bytes, before/expected journal hashes, completed mutation, inspections before/after patch and final parsed content. Native additionally checks real assistant tool calls.

| Pair | Mode | PASS | Model turns | Tools | Mutation | Execution latency | Malformed tool protocol / stalls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Original native prompt | JSON | No | 3 | 3 | applied | 3562 ms | 0 / 0 |
| Original native prompt | native | **Yes** | 4 | 3 | applied | 3895 ms | 0 / 0 |
| After native prompt adjustment | JSON | No | 3 | 3 | applied | 3137 ms | 0 / 0 |
| After native prompt adjustment | native | **Yes** | 4 | 3 | applied | 3942 ms | 0 / 0 |

JSON did perform the mutation, but its final content was `marker="UUID","state":"STATE_DONE"`, not a valid JSON object. This is final-answer validation failure, not malformed tool-envelope parsing. Native returned a valid object with the actual UUID. Thus the result supports reliable native request/response and finalization on this control; it does **not** demonstrate that native is faster or repairs the real coding bottleneck.

Latest native call IDs: `call_ry9j3hkg` (fs.read), `call_idp8rjw6` (fs.patch), `call_2zsrlfmm` (fs.read). Final marker `48b9491c-daef-46c2-92ed-1f285a02724a`. Actual file equals expected, journal verification `applied`.

The first exploratory pair is retained separately: native patched correctly but used fs.search instead of the required initial fs.read, so strict PASS was denied. The common instruction was clarified to require fs.read first, then **both** modes were rerun. Criteria were not relaxed and no acceptance attempt was spent before strict native PASS.

Raw evidence in `apps/server/data/jabberwock/`:

- `native-comparison-first.json`: exploratory failure, including cold warmup 52901 ms.
- `native-comparison-original-prompt.json`: strict original-prompt pair, warmup 3242 ms.
- `native-comparison.json`, `native-comparison-json.json`, `native-comparison-native.json`: final pair, warmup 465 ms; complete Runs, usage, file content and hashes.

## Continuation and the one controlled prompt experiment

Protocol continuation recorded Decision `decision_248b2a50-6806-4495-99fb-51669ef6ccee`: **“User approved retrying the same route with qwen3:8b native tool calling after executor protocol change.”** It preserved prior attempts, all 46 previous Runs, six completed Steps, Task/Route/Step IDs and evidence, granting three bounded attempts: **8 → 11**. Executor fixed Qwen/native/read_write, maxToolTurns 16; per-step timeout retained at 600000 ms. No external acceptance execute_step was issued; the existing RouteRunner autonomously invoked execution and verification.

| Attempt | Executor Run | Model turns / tools | Run elapsed | Mutations | Result |
| --- | --- | --- | --- | --- | --- |
| 9 | `run_6f6415b9-9842-4e6e-9a39-dc19f4d6b88a` | 12 / 12 | 30260 ms | 0 | stalled inspections |
| 10 | `run_5525ccde-a4a0-43a7-b90d-fe7258c6bb96` | 12 / 12 | 42416 ms | 0 | stalled inspections |
| 11 | `run_dbb69b36-3a55-4a99-98bc-0bfc5f17d82d` | 11 / 11 | 35002 ms | 0 | stalled inspections |

Because native smoke passed but real execution only read/searched, the requested **one controlled prompt experiment outside the route** compared the current prompt and a minimal coding-agent prompt on the same disposable read/patch/read task/workspace/budgets. Both passed: current 4548 ms; minimal 2812 ms; each 4 model turns, 3 native calls, valid final and verified mutation hashes. These single ordered measurements do not establish prompt causality for the real failure. Evidence: `native-prompt-comparison.json`.

Following the user's instruction to minimally adjust a successful coding prompt, native was shortened generically; scope/constraints and safety remain. Renewed native smoke passed before one final bounded continuation. Decision `decision_d0038ce7-4f33-4bdf-9836-8c66512a3ff8` explains the experiment, its causal limitation and the prompt adjustment. Attempts **11 → 14**, preserving all 52 existing Runs.

| Attempt | Executor Run | Model turns / tools | Run elapsed | Mutations | Result |
| --- | --- | --- | --- | --- | --- |
| 12 | `run_f9010fc4-ae4e-4542-bcda-600a249cddf3` | 4 / 4 | 9941 ms | 0 | repeated fs.read |
| 13 | `run_1b6cbd05-1db7-45d3-aa6e-b29333a64239` | 4 / 4 | 8315 ms | 0 | repeated fs.read |
| 14 | `run_6ed90897-b6d2-4b4d-9e73-a4a45b7bfe35` | 4 / 4 | 9165 ms | 0 | repeated fs.read |

Across both cycles: **47 actual native model calls, 47 inspection tools, zero mutation requests, zero malformed native responses, zero new package-process receipts**. All six executor runs stopped through the progress detector, not model/endpoint errors or the 16-turn limit. Six deterministic verifier Runs rejected missing source wiring with zero model calls. Bonsai stays pinned at 8080, read_only, original policies, 90000-ms verification timeout; no heavy-verifier reintroduction.

Now **58 Runs**, all old IDs preserved; completed progress **6/10 → 6/10**, attempts/maxAttempts **8 → 14**. Driver guards permit only the original protocol cycle at attempt 8 and prompt cycle at attempt 11; rerunning it at attempt 14 cannot grant another cycle. No new acceptance route was created.

Raw cycle evidence: `native-continuation-original-prompt.json`, `native-continuation-minimal-prompt.json`, their logs and `native-api-final-state.json`. Native API GET on 4317 independently confirms persisted final BLOCKED/max_attempts, fixed Qwen/native config and unchanged fixed Bonsai policies.

## PersonaCore result and remaining limitation

No PersonaCore edit occurred during these cycles, manually or through the executor. Background SHA256 before/after both cycles remains:

`5fdb678e0c2f080496abf2736739fa2371e547de967e362b75a8080bf6374da8`

Final verifier counterevidence: one helper implementation, **zero actual setJabberwockToolbarActive calls**, **zero chrome.storage.onChanged.addListener calls**, missing background lifecycle literals `started` and `jabberwock-supervisor:`. Existing dispatcher started/completed records remain present. Actual success/error/overlap/init wiring is not accepted. **PersonaCore build/test were not executed by these cycles; no exit-0 build claim is made.**

The native infrastructure succeeds on a real mutation task and removes reliance on custom JSON tool envelopes. It does not eliminate Qwen's inspection loop on the existing corrective task. The route remains honestly BLOCKED; additional blind retries or model downloads were not performed.

Persona Bridge remained in the user-specified OFF state; every driver explicitly disables bridge auto-start. Client OFF was not independently checked through UI. The preexisting companion listener was not changed. No ChatGPT/browser automation, cloud/KIE/RuTronix inference, cloud fallback, new model installation or external acceptance execute_step.

## Validation and deployment state

Focused touched-area suite: **81 tests PASS, 10 files**, including native parsing/multiple calls/roundtrip/read/patch/journal, permissions, cancellation, max turns, malformed responses/manual JSON rejection, final without calls, JSON regression, auto confirmation/no fallback, replay rejection, journal retention after interrupted model call, persisted config and read-only verifier isolation. Server TypeScript build **exit 0**. Logs: `native-focused-tests.log`, `native-server-build.log`.

The fresh experiment driver executed current source for the real local smoke and acceptance cycles. The existing API process on 4317 was not restarted in this task; it reads current persisted route state, but its loaded handlers/runtime require reload before serving the new native mode directly. Source and built server contain the change. The previous task's rejected process-stop action was not retried or bypassed here.

Graphify is updated AST-only after code changes. Inspection stayed scoped to runtime/provider/route configuration and focused tests; server-path/YuE config loading was checked only to diagnose a test initialization error caused by a misplaced generated evidence directory. Those generated files were moved into the evidence directory, then the full focused suite passed. No unrelated source repair was made.
