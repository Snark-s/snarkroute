# Claude in SnarkRoute

The repository rules are shared with Codex and live in AGENTS.md:

@AGENTS.md

Before connecting anything new (provider, local worker, MCP tools, agent), read
@docs/CONNECTING-NEW-ENTITY.md — it holds the owner's standing rules.

What you can drive right now through the `snarkroute` MCP server
(http://127.0.0.1:4317/mcp): `image_generate`, `image_job`, `image_cancel`,
`image_view` (local FLUX.3 Klein via the Model Gateway), `local_runtime_*` (GPU
admission and runtimes), `jabberwock_*` (routes), `ae_*` (After Effects).
