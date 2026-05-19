# Terminology

This document defines the shared conceptual vocabulary for SnarkRoute, BoojumRoute, and Open Route Protocol.

## SnarkRoute And BoojumRoute

SnarkRoute is the object and workspace layer. It focuses on artifacts, boards, versions, relations, libraries, and user-facing actions.

BoojumRoute is the process-authoring layer. It focuses on blocks, routes, ports, execution, compound nodes, and model/API orchestration.

Short formula:

- SnarkRoute works with Artifacts.
- BoojumRoute builds Blocks and Routes.
- Boojum compound routes can be exposed in SnarkRoute as Actions.

## Node

A Node is a generic graph item. It is an umbrella concept, not only an executable process block.

Node kinds include at least:

- ArtifactNode
- BlockNode

Legacy route files, APIs, package formats, and internal TypeScript names may still use `node` for compatibility. In user-facing SnarkRoute UI, visible creative objects should preferably be called Artifacts rather than Nodes.

## Artifact / ArtifactNode

An ArtifactNode is a content or media object placed on a SnarkRoute board.

Examples include:

- image
- video
- audio
- text
- prompt
- mask
- reference
- generated output

ArtifactNodes are user-facing creative objects. They are not executable operations by themselves.

An ArtifactNode may have versions, a stack, a current version, provenance, prompt context, model context, style context, and attached input or reference materials.

## Block / BlockNode

A BlockNode is an executable operation or process block.

Examples include:

- generate image
- edit image
- upscale
- crop
- animate
- extract frame
- transcribe audio
- call model
- call API

In BoojumRoute, most traditional route nodes are BlockNodes. A Boojum compound node or compound route is a reusable process made from BlockNodes.

## Action

An Action is a user-facing invocation of a BlockNode or Boojum route.

In SnarkRoute, Actions usually appear as contextual buttons on an Artifact card. For example, when a user selects an image Artifact, SnarkRoute may show actions such as Edit, Animate, Upscale, or Crop. Clicking an action runs an underlying Boojum BlockNode or compound route. The result becomes either a new ArtifactNode or a new version in the source Artifact stack.

Important mapping:

```text
Boojum compound route/block = SnarkRoute action button
```

## Route

A Route is an executable graph or process. Open Route Protocol route documents describe executable graph structure, dependencies, parameters, provenance, economics metadata, and asset references.

Do not collapse Route and Board into the same concept.

## Board

A Board is a visual workspace and editable composition. It can contain:

- nodes
- artifact cards
- block nodes, when shown explicitly
- edges and relations
- layout
- groups and comments
- artifact versions and stacks
- action history and provenance
- selected libraries and imports

A Board can be treated as a library-like portable composition: a reusable collection of objects, relations, layout, and context.

Board and Route are related but distinct:

- Route = executable graph/process
- Board = editable visual workspace/composition

## Library

A Library is a portable reusable collection.

Libraries may contain or reference:

- artifacts
- blocks
- routes
- boards
- prompt chips
- styles
- model presets
- assets

Libraries may import other libraries by reference. Imports are dependency/reference links, not necessarily physically nested folders. Circular imports are invalid.

## Prompt Chips

Prompt Chips are reusable prompt fragments shown as visual chips in the prompt editor.

A prompt may be assembled from:

- library prompt chips
- inline text
- inherited style/context
- references from the current artifact

Example:

```text
[Style: dark children room] [Task: replace faces] [Negative: no glow] + inline text
```

Prompt chips are references to reusable prompt fragments. They should not be documented merely as copied text.

---

This document is licensed under CC BY-SA 4.0.
