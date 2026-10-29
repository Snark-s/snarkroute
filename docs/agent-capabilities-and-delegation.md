# SnarkRoute: Agent Capability Registry and Delegation

Status as of 2026-10-29: **Phase 1 implemented and typechecked** (read-only coding-agent discovery); durable task delegation is **not implemented**. Never treat the presence of a CLI as an already-running delegated job.

## Purpose

Every connected agent should be able to ask SnarkRoute what it is able to do, then delegate an appropriate complex task to a specialist without inventing capabilities, guessing subscription limits, repeatedly asking the owner for the same permission, or bypassing local sandbox rules.

Existing infrastructure:
- SnarkRoute's model gateway, ORP routes, node and portable tools, specialized MCP tools (Adobe AE, local runtime, images, model exposure, CozyClay, Jabberwock, Tech Radar).
- `apps/server/src/routes/persona-agent.ts` already has a PersonaCore-to-Codex Desktop handoff; this is not a general result-returning executor.
- SnarkBridge has its own file/process/browser/mail/agent scopes and approved workflows; only a connecting agent with a matching MCP client and permissions can call those.
- Codex CLI and Claude Code CLI are installed and authenticated on this owner's machine as of 2026-10-29, **but remaining quota was not available from auth status**.

## Phase 1: Discover, not delegate (implemented)

SnarkRoute MCP now registers `coding_agents_discover`, accessible to clients with the existing authenticated local MCP connection. It runs the read-only `scripts/discover-coding-agents.ps1` and returns:

```json
{
  "schema_version": 1,
  "executors": [
    {"id": "codex", "installed": true, "authenticated": true, "version": "...", "quota": "unknown", "callable": true, "launch": "codex exec"},
    {"id": "claude-code", "installed": true, "authenticated": true, "version": "...", "quota": "unknown", "callable": true, "launch": "claude -p"}
  ],
  "delegation": {"status": "not_yet_implemented"}
}
```

No prompts, provider API calls, account secrets, or paid tasks are involved in discovery. The result can change at runtime; do not copy these values into a static agent persona.

Implementation:
- `scripts/discover-coding-agents.ps1`
- `apps/server/src/mcp/coding-agent-tools.ts`
- Registration and tool instructions in `apps/server/src/mcp/server.ts`

Validation: `pnpm --filter @snarkroute/server exec tsc --noEmit -p tsconfig.json` passed on 2026-10-29. Existing running server may need a normal restart/hot reload to load newly registered tool; the MCP endpoint itself has not been live-smoke-tested.

## Phase 2: Universal delegation (required)

Expose the same contract through both authenticated MCP and the local SnarkRoute HTTP API, and make it available to every authorized agent runtime:

- `agent_capabilities`: discover actions, providers, cost class, security scope, real availability, and whether proof of a successful action exists. Live discovery should be the source of truth. Tool registry entries are not proof of function.
- `agent_delegate_submit`: accept purpose, task description, evidence/artefacts, target workspace, constraints, cost/time budget, preferred executor. Return durable job id and state; never report completed on submission.
- `agent_delegate_status`: persisted state and whether the provider is running, waiting, blocked, failed or complete.
- `agent_delegate_result`: result text, changed file summary, test outcome, actual provider, costs where measurable and independently verified acceptance criteria.
- `agent_delegate_cancel`: cancel an owned active job, without killing arbitrary user processes.

Executors:
1. Local SnarkRoute model route for cheap tasks, **local first** if capable.
2. Codex CLI (subscription credentials), best for coding and repository edits.
3. Claude Code CLI (subscription credentials), alternate when Codex unavailable/unsuited/at limit.
4. Extension for specialized agents via registered adapters, not by hardcoded brand names.

Subscription limits:
- `authenticated=true` is NOT `quota_available=true`.
- Use `quota=unknown` until a supported provider status gives reliable availability. Do not scrape local auth tokens, quotas, private UI or approximate remaining message count.
- On an actual explicit rate-limit/usage-limit response, mark that executor as `exhausted` or `cooldown`; store provider-provided retry timing if available. Do not confuse authentication failures, network errors and quotas.
- Never silently switch to pay-per-token API or change billing provider. Prefer local, then permitted subscriptions; stop if no eligible quota remains.
- Add conservative max jobs per agent, per workspace, and per day, so multiple agents do not exhaust the same subscription simultaneously.

Execution controls:
- Owner-controlled policy and workspace allowlists; no arbitrary shell from untrusted prompts.
- `codex exec` with workspace-write and safe approvals, not dangerous bypass flags.
- `claude -p` with appropriate workspace permission constraints and bounded turns. No blanket bypass-permissions mode.
- Persistent idempotency keys, per-workspace mutexes, timeouts, bounded logs and output, cancellation, and no retry on unknown outcomes without explicit safety.
- Clear chain of responsibility: delegator -> executing specialist -> evaluator; protect against infinite self-delegation and circular delegation.
- All model routing and economics respect `docs/CONNECTING-NEW-ENTITY.md` and SnarkRoute's centralized policy.
- Owner authority is represented by actual configured policy, not by claims in a prompt. Only the owner changes protected policies.
- No claim of success until independently verified in files, tests, website or external artifact, as appropriate.

## Agent awareness: disclose abilities, not exhaust the context

Each agent's startup message should include only a tiny stable hint:
> Before refusing a task you might be able to delegate, call the SnarkRoute capability catalog. Choose the cheapest suitable permitted executor. Do not guess availability, permissions or subscription quotas; submit through durable jobs and verify results.

The registry returns compact descriptions and where/how to discover details on demand. Agents should never need a multi-page list of all tools in their permanent prompt.

## Acceptance tests for Phase 2

- Agent A asks for capabilities and finds two coding executors without calling either model.
- Agent A cannot complete a scoped code task, submits it to Codex; receives job id; the resulting changed files and tests are visible.
- Codex returns a confirmed quota limit: Claude Code is selected only if authorized, quota not explicitly exhausted, and the task's budget permits it. No paid API fallback.
- Both coding subscriptions unavailable: explicit no-capacity status, no claim of delegation.
- Two agents target same repository: one job waits; no simultaneous writes.
- Restart midway: job status and logs persist; no duplicate execution.
- Unauthorized directory, credential, payment, identity-verification or destructive operations remain blocked.
- MCP instructions and the capability registry are visible to agents that connect to SnarkRoute, without requiring owner to repeat the same explanation.

## Notes on scope

Phase 1 detects coders only. Model gateway, media tools, desktop workflows and external apps require their own dynamic health/permission probes for a complete catalog. Avoid equating an installed tool or previously documented capability with confirmed permission to run it.
