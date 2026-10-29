# Claude in SnarkRoute

The repository rules are shared with Codex and live in AGENTS.md:

@AGENTS.md

Buzha (`buzha` in `local_runtime_status|start|stop`) is the local orders bureau
at the registry URL, also available in the Workshop Agents tab. `ready` means
the UI is up; automation is false. Orders/tasks are entered manually; chat has
no tools and uses SnarkRoute's Model Gateway. Future executor questions go
through Secretary. Setup and live checks: `docs/buzha.md`.

Before connecting anything new (provider, local worker, MCP tools, agent), read
@docs/CONNECTING-NEW-ENTITY.md — it holds the owner's standing rules.

What you can drive right now through the `snarkroute` MCP server
(http://127.0.0.1:4317/mcp): `image_generate`, `image_job`, `image_cancel`,
`image_view` via the Model Gateway, with two local providers: `flux3_native`
(FLUX.3 Klein: new images, style) and `qwen_edit_local` (Qwen-Image-Edit-2511:
precise edits of a given image, "change X, keep the rest"; pass the image in
`references`); `local_runtime_*` (GPU admission and runtimes: `flux3`,
`qwen_edit`), `jabberwock_*` (routes), `ae_*` (After Effects).

Text through the owner's Claude Pro/Max plan: provider `claude_subscription`,
models `subscriptions/anthropic/{opus,sonnet,haiku}` in the shared catalog, run by
the official Claude Code CLI (`claude -p`, no tools, no API key, quota-aware;
cost tier `subscription` between local and free). Status, login, streaming and
conversations: `/api/claude-subscription/*`; live check
`apps/server/scripts/claude-subscription-smoke.ts`; details `docs/claude-subscription.md`.

Text through the owner's ChatGPT Plus/Pro plan: provider `chatgpt_subscription`,
models `subscriptions/openai/default` plus the live `codex debug models` list, run by the
official Codex CLI (`codex exec` with the ChatGPT login, no tools, no API key, quota from
Codex's own session file; same `subscription` tier, no streaming deltas). Status, login and
conversations: `/api/chatgpt-subscription/*`; live check
`apps/server/scripts/chatgpt-subscription-smoke.ts`; details `docs/chatgpt-subscription.md`.

`models_list` shows which SnarkRoute models the owner shares with other networks,
grouped by type. The owner sets "local only" / "selected only" in the Workshop:
System → Models and providers (`/api/system/model-exposure`, stored in
`apps/server/data/model-exposure.json`). Model Gateway rejects MCP jobs for hidden models.

Agent operations (`agent_*`, `computer_mode_status`; HTTP `/api/agent-ops/*`): capability
catalog with registered/discovered/available/verified status, delegation of durable tasks to
`local_route`, `codex_cli` or `claude_code` with checks run by SnarkRoute itself, GPU/RAM leases,
the owner's computer modes (Europe/Moscow schedule, manual override) and a shared quota ledger.
Workshop: top status bar on every tab and "Диспетчер задач агентов" in the Agents tab. Live checks:
`apps/server/scripts/agent-ops-mcp-smoke.ts`, `apps/server/scripts/agent-ops-smoke.ts`; details
`docs/agent-capabilities-and-delegation.md`.

Acceptor (`agent_acceptor_status`, `agent_delegate_verify`, `agent_delegate_pause/resume`,
`agent_task_effect`, `agent_task_amend`): session completion never closes the task.
Submit immutable criteria with independent checks; rejection enqueues concrete continuation.
Reserve external effects before acting and reconcile uncertain results before retrying.
Model review waits for permissions, quota and GPU/RAM instead of claiming success.
Details: `docs/agent-acceptor.md`; controlled end-to-end: `apps/server/scripts/agent-acceptor-smoke.ts`.

Buzha is a persistent `app:buzha` agent using her existing SQLite and identity.
Discover `tools:buzha`; use `buzha_message` with a stable requestKey and
`buzha_status/task/control`. Her structured model/tool loop uses the shared
queue and Acceptor, scoped SnarkBridge and paired Chrome Profile 13. ChatGPT
retains both schedule owners; no duplicate local jobs. See `docs/buzha-agent.md`.

`tech_radar_research` queues public GitHub research without running project code or
using paid APIs; `tech_radar_catalog` reads results and the workshop capability map.
Open `/tech-radar` in SnarkRoute or BoojumRoute for research, decisions and history.
Catalog declarations never prove local readiness. Installations need a separate request.
