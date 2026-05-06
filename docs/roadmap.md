# SnarkRoute Roadmap

## Milestone A: Stable MVP Foundation

Status: mostly done / in progress.

- route import/export
- validation
- execution
- existing local nodes
- UI graph editor
- logs and previews
- Replicate adapter and Clarity Upscaler route
- local run storage and accounting metadata

## Milestone B: AssetRef Foundation

Goal: introduce AssetRef, AssetSource, and AssetResolver as core architecture.

- define AssetRef type
- define normalized Asset type
- define AssetSource type
- implement local-folder AssetSource
- implement embedded AssetSource
- implement resolver diagnostics
- add schema validation for text assets
- add missing asset diagnostics
- add hash calculation support

## Milestone C: Prompt Library As First Text Asset Source

Goal: implement Prompt Library as a local text asset source.

- scan `data/prompt-library/**/*.prompt.md`
- parse frontmatter and Markdown body
- normalize prompt files into `text/prompt` assets
- expose prompt assets through AssetResolver
- add `library.prompt` node using `assetRef`
- add category/prompt selection UI
- add refresh prompt library action
- add starter prompt files
- add tests

`library.prompt` must not contain linked or embedded mode. It stores `assetRef` only.

## Milestone D: Export Modes

Goal: move portability decisions to export.

- linked export
- embedded export
- bundle export
- export diagnostics for unresolved assets
- import handling for embedded and bundled assets
- documentation and examples

## Milestone E: Remote AssetSources

Goal: allow cautious connection of external asset libraries.

- remote manifest schema
- add external source flow
- validate remote manifests
- list remote assets
- cache remote assets
- hash mismatch warnings
- missing asset warnings
- permission display
- block unsupported asset kinds

## Milestone F: Node Definitions As Assets

Goal: allow node definitions to be distributed as validated assets.

- `node/definition` asset schema
- UI metadata support
- input/output schema validation
- execution adapter declarations
- permissions model
- block arbitrary executable code by default
- add example remote API node definition

## Milestone G: Provider/API Nodes And Demo Routes

Goal: make SnarkRoute useful to show.

- stable image generation node
- stable upscale node
- local Stable Diffusion node if available
- Replicate or Gemini/Nano Banana API node
- Prompt Library demo route
- route using text asset -> generator -> preview/output
- demo route with retro-futuristic editor joke prompt

## Milestone H: Photoshop Plugin Integration

Goal: connect SnarkRoute to Photoshop workflows.

- define Photoshop node interface
- define Photoshop asset/preset references
- connect generated outputs to Photoshop plugin
- support selected layer / document input where possible
- produce image output back to SnarkRoute
- document limitations

## Milestone I: User-Facing Preview

Goal: show SnarkRoute to trusted early users.

Internal demo: can be shown now to technically sympathetic people.

First serious early-user demo: show after Milestone D and at least one working image-generation route.

Reason: before AssetRef and export modes, users may misunderstand SnarkRoute as just another node editor. After AssetRef, Prompt Library, and export modes, the unique idea becomes visible: portable routes that can reference reusable local or external assets safely.

Do not show it as a finished product. Show it as a local-first visual route editor for AI workflows with portable routes and reusable asset libraries.

## Future Focused Tests

- AssetRef validation
- local prompt discovery
- prompt file parsing
- resolving `text/prompt` assets
- missing asset diagnostics
- hash mismatch diagnostics
- linked export keeps AssetRefs
- embedded export embeds resolved assets
- bundle export includes asset files and manifest
- `library.prompt` outputs resolved text
- remote manifests are schema-validated
- unsupported remote asset kinds are blocked
- remote node definitions cannot execute arbitrary code by default

This document is licensed under CC BY-SA 4.0.
