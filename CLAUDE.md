# Claude in SnarkRoute

The repository rules are shared with Codex and live in AGENTS.md:

@AGENTS.md

Before connecting anything new (provider, local worker, MCP tools, agent), read
@docs/CONNECTING-NEW-ENTITY.md — it holds the owner's standing rules.

What you can drive right now through the `snarkroute` MCP server
(http://127.0.0.1:4317/mcp): `image_generate`, `image_job`, `image_cancel`,
`image_view` via the Model Gateway, with two local providers: `flux3_native`
(FLUX.3 Klein: new images, style) and `qwen_edit_local` (Qwen-Image-Edit-2511:
precise edits of a given image, "change X, keep the rest"; pass the image in
`references`); `local_runtime_*` (GPU admission and runtimes: `flux3`,
`qwen_edit`), `jabberwock_*` (routes), `ae_*` (After Effects).
