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

`models_list` shows which SnarkRoute models the owner shares with other networks,
grouped by type. The owner sets "local only" / "selected only" in the Workshop:
System → Models and providers (`/api/system/model-exposure`, stored in
`apps/server/data/model-exposure.json`). Model Gateway rejects MCP jobs for hidden models.

`tech_radar_research` queues public GitHub research without running project code or
using paid APIs; `tech_radar_catalog` reads results and the workshop capability map.
Open `/tech-radar` in SnarkRoute or BoojumRoute for research, decisions and history.
Catalog declarations never prove local readiness. Installations need a separate request.
